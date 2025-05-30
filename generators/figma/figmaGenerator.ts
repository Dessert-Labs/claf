import fs from "fs";
import path from "path";
import { logger } from "../../utils/logger.js";
import tinycolor from "tinycolor2";
import StyleDictionary from "style-dictionary";
import type { DesignToken, ValueTransform } from "style-dictionary/types";
const { glob } = await import("glob");

// Types
interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface FigmaVariable {
  name: string;
  type: string;
  value: number | string | FigmaColor;
}

interface FigmaMode {
  name: string;
  variables: FigmaVariable[];
}

interface FigmaCollection {
  name: string;
  modes: FigmaMode[];
}

// Clean output directory
function cleanDist(): void {
  const distDir = path.resolve("build/figma");
  try {
    fs.rmSync(distDir, { recursive: true, force: true });
    logger.info(`Removed ${distDir}`);
  } catch (err) {
    // ignore
  }
  fs.mkdirSync(distDir, { recursive: true });
  logger.success(`Created fresh ${distDir}`);
}

// Transformers for Figma
StyleDictionary.registerTransform({
  name: "figma/color",
  type: "value",
  filter: (token: DesignToken) => token.original.$type === "color",
  transform: (token: DesignToken): FigmaColor => {
    const value = token.original.$value;
    if (!value) {
      logger.warn(`No color value found for token: ${token.name}`);
      return { r: 0, g: 0, b: 0, a: 1 };
    }

    // Handle references by getting the resolved value
    const resolvedValue = typeof value === 'string' && value.startsWith('{') 
      ? token.value // Use the already resolved value from Style Dictionary
      : value;

    const { r, g, b, a } = tinycolor(resolvedValue).toRgb();
    return {
      r: r / 255,
      g: g / 255,
      b: b / 255,
      a: a
    };
  }
} as ValueTransform);

StyleDictionary.registerTransform({
  name: "figma/dimension",
  type: "value",
  filter: (token: DesignToken) => token.$type === "dimension",
  transform: (token: DesignToken): number => {
    const value = token.$value;
    if (!value) {
      logger.warn(`No dimension value found for token: ${token.name}`);
      return 0;
    }
    return parseFloat(String(value).replace('px', ''));
  }
} as ValueTransform);

StyleDictionary.registerTransform({
  name: "figma/fontWeight",
  type: "value",
  filter: (token: DesignToken) => token.$type === "fontWeight",
  transform: (token: DesignToken): number => {
    const value = token.$value;
    if (!value) {
      logger.warn(`No font weight value found for token: ${token.name}`);
      return 400;
    }

    const weightMap: Record<string, number> = {
      'normal': 400,
      'medium': 500,
      'semibold': 600,
      'bold': 700
    };
    return weightMap[String(value)] || parseInt(String(value));
  }
} as ValueTransform);

// Custom formatter for Figma variables
StyleDictionary.registerFormat({
  name: 'figma/variables',
  format: ({ dictionary }) => {
    const collections: FigmaCollection[] = [
      {
        name: "Light",
        modes: [{ name: "Default", variables: [] }]
      },
      {
        name: "Dark",
        modes: [{ name: "Default", variables: [] }]
      }
    ];

    dictionary.allTokens.forEach(token => {
      const isDark = token.filePath.includes('.dark.json');
      const collection = collections[isDark ? 1 : 0];
      const mode = collection.modes[0];

      const variable: FigmaVariable = {
        name: token.path.join('/'),
        type: getFigmaVariableType(token.$type || ''),
        value: token.$value || ''
      };

      // Transform the value based on type
      if (token.$type === 'color') {
        // For color tokens, use the resolved value from Style Dictionary
        const resolvedValue = token.$value;
        if (typeof resolvedValue === 'string') {
          // If it's still a string (reference), try to resolve it
          const color = tinycolor(resolvedValue).toRgb();
          variable.value = {
            r: color.r / 255,
            g: color.g / 255,
            b: color.b / 255,
            a: color.a
          };
        } else if (resolvedValue && typeof resolvedValue === 'object') {
          // If it's already an object (RGB), use it directly
          variable.value = resolvedValue as FigmaColor;
        } else {
          // Fallback to black if we can't resolve the color
          variable.value = { r: 0, g: 0, b: 0, a: 1 };
        }
      } else if (token.$type === 'dimension') {
        variable.value = parseFloat(String(token.$value).replace('px', ''));
      } else if (token.$type === 'fontWeight') {
        const weightMap: Record<string, number> = {
          'normal': 400,
          'medium': 500,
          'semibold': 600,
          'bold': 700
        };
        variable.value = weightMap[String(token.$value)] || parseInt(String(token.$value));
      } else {
        variable.value = token.$value;
      }

      mode.variables.push(variable);
    });

    return JSON.stringify(collections, null, 2);
  }
});

// Helper functions
function getFigmaVariableType(tokenType: string): string {
  switch (tokenType) {
    case "color": return "COLOR";
    case "dimension": return "FLOAT";
    case "fontWeight":
    case "fontSize":
    case "lineHeight":
    case "letterSpacing": return "FLOAT";
    case "fontFamily": return "STRING";
    default: return "STRING";
  }
}

// Main build function
async function main(): Promise<void> {
  cleanDist();

  const sourceFiles = [
    "tokens/**/*.json",
    "!tokens/**/*.dark.json"
  ];

  const SD = new StyleDictionary({
    source: sourceFiles,
    platforms: {
      figma: {
        transforms: ["figma/color", "figma/dimension", "figma/fontWeight"],
        buildPath: "build/figma/",
        files: [
          {
            destination: "variables.json",
            format: "figma/variables",
            options: {
              outputReferences: true
            }
          }
        ]
      }
    }
  });

  // Register the reference transform
  StyleDictionary.registerTransform({
    name: 'figma/reference',
    type: 'value',
    filter: (token: DesignToken) => {
      return token.original.$value && typeof token.original.$value === 'string' && token.original.$value.startsWith('{');
    },
    transform: (token: DesignToken) => {
      const ref = token.original.$value.slice(1, -1); // Remove { and }
      const parts = ref.split('.');
      const resolvedToken = SD.tokens[parts.join('.')];
      return resolvedToken ? resolvedToken.original.$value : token.original.$value;
    }
  } as ValueTransform);

  // Add the reference transform to the platform
  if (SD.platforms.figma?.transforms) {
    SD.platforms.figma.transforms.push('figma/reference' as any);
  }

  SD.buildAllPlatforms();
  logger.success("Figma variables built!");
}

main().catch((err) => {
  logger.error(`Error building Figma variables: ${err}`);
  process.exit(1);
});

export { main }; 