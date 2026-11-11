// Pattern rules for languages the built-in extractors do not cover; a project's
// .findwright/config.json lists the ones it needs.

const NOT_A_CALL = "(?!(?:return|else|if|while|for|switch|case|delete|new|throw|sizeof|co_return|co_await)\\b)";

const cpp = [
  { globs: ["**/*.cpp", "**/*.h", "**/*.hpp", "**/*.cc", "**/*.c"], kind: "type",
    pattern: "^\\s*(?:template\\s*<[^>]*>\\s*)?(?:class|struct|union|enum(?:\\s+class)?)\\s+(?:[A-Z_]+_API\\s+)?(?<name>[A-Za-z_]\\w*)\\b(?!\\s*;)" },
  { globs: ["**/*.cpp", "**/*.cc", "**/*.c"], kind: "function",
    pattern: `^${NOT_A_CALL}[\\w:<>,*&~ ]*?[\\s*&](?<name>~?[A-Za-z_]\\w*(?:::~?[A-Za-z_]\\w*)*)\\s*\\([^;]*$` },
  { globs: ["**/*.h", "**/*.hpp"], kind: "method",
    pattern: `^\\s+${NOT_A_CALL}(?:(?:virtual|static|inline|constexpr|explicit|_FORCE_INLINE_)\\s+)*[\\w:<>,*&]+[\\s*&]+(?<name>~?[A-Za-z_]\\w*)\\s*\\(` },
  { globs: ["**/*.cpp", "**/*.h"], kind: "macro", pattern: "^\\s*#define\\s+(?<name>[A-Za-z_]\\w*)" },
];

const gdscript = [
  { globs: ["**/*.gd"], kind: "function", pattern: "^\\s*(?:static\\s+)?func\\s+(?<name>\\w+)" },
  { globs: ["**/*.gd"], kind: "class", pattern: "^(?:class_name|\\s*class)\\s+(?<name>\\w+)" },
  { globs: ["**/*.gd"], kind: "signal", pattern: "^\\s*signal\\s+(?<name>\\w+)" },
  { globs: ["**/*.gd"], kind: "constant", pattern: "^\\s*(?:const|enum)\\s+(?<name>\\w+)" },
  { globs: ["**/*.gd"], kind: "variable", pattern: "^(?:@\\w+(?:\\([^)]*\\))?\\s+)*var\\s+(?<name>\\w+)" },
  { globs: ["**/*.gdshader", "**/*.gdshaderinc", "**/*.glsl"], kind: "function",
    pattern: "^\\s*(?:void|float|int|uint|bool|vec[234]|ivec[234]|mat[234])\\s+(?<name>\\w+)\\s*\\(" },
  { globs: ["**/*.gdshader", "**/*.gdshaderinc", "**/*.glsl"], kind: "uniform",
    pattern: "^\\s*(?:global\\s+|instance\\s+)?uniform\\s+\\w+\\s+(?<name>\\w+)" },
  { globs: ["**/*.tscn"], kind: "node", pattern: "^\\[node name=\"(?<name>[^\"]+)\"" },
];

const dart = [
  { globs: ["**/*.dart"], kind: "type",
    pattern: "^\\s*(?:(?:abstract|sealed|final|base|interface|mixin)\\s+)*(?:class|mixin|enum|extension(?:\\s+type)?|typedef)\\s+(?<name>\\w+)" },
  { globs: ["**/*.dart"], kind: "function",
    pattern: `^\\s*${NOT_A_CALL}(?:(?:static|external|final|const|late|override|@override)\\s+)*(?:[A-Z]\\w*(?:<[^()]*>)?\\??|void|int|double|bool|num|dynamic)\\s+(?<name>[a-z_]\\w*)\\s*(?:<[^()]*>)?\\(` },
  { globs: ["**/*.dart"], kind: "getter", pattern: "\\bget\\s+(?<name>[a-zA-Z_]\\w*)\\s*(?:=>|\\{|async)" },
  { globs: ["**/*.dart"], kind: "constructor", pattern: "^\\s*(?:const\\s+|factory\\s+)?(?<name>[A-Z]\\w*\\.\\w+)\\s*\\(" },
  { globs: ["**/*.arb"], kind: "key", pattern: "^\\s*\"(?<name>[a-zA-Z]\\w*)\"\\s*:" },
];

// Rule sets by language, picked per project in projects.local.json.
export const RULE_SETS = { cpp, gdscript, dart };
