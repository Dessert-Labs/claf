import fs from "fs";
import path from "path";
import { logger } from "../../utils/logger.js";
import tinycolor from "tinycolor2";
import StyleDictionary from "style-dictionary";
const { glob } = await import("glob");

// Clean output directory
function cleanDist() {
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
  matcher: (token) => token.original.$type === "color",
  transform: (token) => {
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
});

StyleDictionary.registerTransform({
  name: "figma/dimension",
  type: "value",
  matcher: (token) => token.$type === "dimension",
  transform: (token) => {
    const value = token.$value;
    if (!value) {
      logger.warn(`No dimension value found for token: ${token.name}`);
      return 0;
    }
    return parseFloat(value.replace('px', ''));
  }
});

StyleDictionary.registerTransform({
  name: "figma/fontWeight",
  type: "value",
  matcher: (token) => token.$type === "fontWeight",
  transform: (token) => {
    const value = token.$value;
    if (!value) {
      logger.warn(`No font weight value found for token: ${token.name}`);
      return 400;
    }

    const weightMap = {
      'normal': 400,
      'medium': 500,
      'semibold': 600,
      'bold': 700
    };
    return weightMap[value] || parseInt(value);
  }
});

// Custom formatter for Figma variables
StyleDictionary.registerFormat({
  name: 'figma/variables',
  format: ({ dictionary }) => {
    const collections = [
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

      const variable = {
        name: token.path.join('/'),
        type: getFigmaVariableType(token.$type)
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
          variable.value = resolvedValue;
        } else {
          // Fallback to black if we can't resolve the color
          variable.value = { r: 0, g: 0, b: 0, a: 1 };
        }
      } else if (token.$type === 'dimension') {
        variable.value = parseFloat(token.$value.replace('px', ''));
      } else if (token.$type === 'fontWeight') {
        const weightMap = {
          'normal': 400,
          'medium': 500,
          'semibold': 600,
          'bold': 700
        };
        variable.value = weightMap[token.$value] || parseInt(token.$value);
      } else {
        variable.value = token.$value;
      }

      mode.variables.push(variable);
    });

    return JSON.stringify(collections, null, 2);
  }
});

// Helper functions
function getFigmaVariableType(tokenType) {
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
async function main() {
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
    matcher: (token) => {
      return token.original.$value && typeof token.original.$value === 'string' && token.original.$value.startsWith('{');
    },
    transform: (token) => {
      const ref = token.original.$value.slice(1, -1); // Remove { and }
      const parts = ref.split('.');
      const resolvedToken = SD.tokens[parts.join('.')];
      return resolvedToken ? resolvedToken.original.$value : token.original.$value;
    }
  });

  // Add the reference transform to the platform
  SD.platforms.figma.transforms.push('figma/reference');

  SD.buildAllPlatforms();
  logger.success("Figma variables built!");
}

main().catch((err) => {
  logger.error("Error building Figma variables:", err);
  process.exit(1);
});

export { main }; 

