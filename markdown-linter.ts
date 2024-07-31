#!/usr/bin/env node
// @ts-check
/*
 *   Markdown linter for MoonBit.
 *   Usage: node markdown_linter.js [args] <inputFile>
 */
import * as MarkdownIt from "markdown-it";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { parseArgs } from "node:util";
import { track } from "temp";

const cli = parseArgs({
  options: {
    version: {
      type: "boolean",
      short: "v",
      description: "Print the version of the linter",
    },
    dump: {
      type: "boolean",
      short: "d",
      description: "Dump the generated moon source code",
    },
    help: {
      type: "boolean",
      short: "h",
      description: "Print this help message",
    },
    suppress: {
      type: "string",
      short: "s",
      description: "Suppress warnings from given comma-separated list",
    },
    ignore: {
      type: "boolean",
      short: "i",
      description: "Ignore error codes from codeblocks",
    },
  },
  allowPositionals: true,
});

if (cli.values.help) {
  console.log(`
Usage: mdlint [args] <inputFile>

Options:
  -h, --help                      Display this help message and exit
  -v, --version                   Display version information and exit
  -d, --dump                      Dump generated moon source code
  -s, --suppress | <list>         Suppress warnings from given comma-separated list
                 | all-warnings   Suppress all warnings
  -i, --ignore                    Ignore error codes from codeblocks

Example:
  mdlint README.md -g -s=e1001,e1002
  `);
  process.exit(0);
}

var globalWarningsSuppressed = false;
var errSet: Set<number> = new Set();

if (cli.values.version) {
  console.log(`Markdown linter ${require("./package.json").version}`);
  globalThis.process.exit(0);
}

if (cli.values.suppress) {
  if (cli.values.suppress == "all-warnings") {
    globalWarningsSuppressed = true;
  } else {
    errSet = new Set(
      cli.values.suppress.split(",").map((s) => parseInt(s.substring(1)))
    );
  }
}

const files = cli.positionals;
const temp = track();

const md = new MarkdownIt();
var hasErrors = false;

for (const inputFile of files) {
  processMarkdown(inputFile);
}

// for instantiating a error from moonc compiler
type Location = {
  line: number;
  col: number;
  offset: number;
};

type Loc = {
  path: string;
  start: Location;
  end: Location;
};

type Diagnostic = {
  $message_type: string;
  level: string;
  loc: Loc;
  message: string;
  error_code: number;
};

function executeCommandLine(workingDir, command) {
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      stdio: "pipe",
      cwd: workingDir,
    });
    return output.trim();
  } catch (error) {
    hasErrors = true;
    return error.stderr.trim() + " " + error.stdout.trim();
  }
}

function makeTempProject(projectName) {
  const projectPath = temp.mkdirSync();
  writeFileSync(
    join(projectPath, "/moon.mod.json"),
    `{ "name": "${projectName}" }`,
    "utf-8"
  );
  writeFileSync(join(projectPath, "/moon.pkg.json"), `{}`, "utf-8");
  return projectPath;
}

type LocationMapping = {
  originalLine: number;
  generatedLine: number;
};

type CodeBlock = {
  content: string;
  kind: "normal" | "expr" | "no-check" | "enclose";
  beginLine: number;
  endLine: number;
};

function processMarkdown(inputFile) {
  const readmeFilename = basename(inputFile);
  const readme = readFileSync(inputFile, "utf-8");

  // parse readme and find codeblocks
  const tokens = md.parse(readme, {});
  var codeBlocks: Array<CodeBlock> = [];

  tokens.forEach((token, index) => {
    const codeInfo = token.info.trim();

    if (
      codeInfo.toLowerCase().startsWith("mbt") ||
      codeInfo.toLowerCase().startsWith("moonbit")
    ) {
      const info = codeInfo.split(" ").map((s) => s.trim());
      var kind;
      if (info.length > 1) {
        switch (info[1].toLowerCase()) {
          case "expr":
            kind = "expr";
            break;
          case "no-check":
            kind = "no-check";
            break;
          case "enclose":
            kind = "enclose";
            break;
          default:
            kind = "normal";
        }
        // parse error codes from codeblocks
        if (cli.values.ignore == false) {
          info.slice(1).forEach((arg) => {
            const errCodes = arg.match(/(?<=-e)\d+/gi);
            errCodes?.forEach((errCode) => errSet.add(parseInt(errCode)));
          });
        }
      } else {
        kind = "normal";
      }
      const { content, map } = token;
      if (map) {
        codeBlocks.push({
          content,
          kind,
          beginLine: map[0] + 1,
          endLine: map[1] + 1,
        });
      }
    }
  });

  // generate source map
  var sourceMap: Array<LocationMapping> = [];
  var line = 1;

  function countLines(str: string) {
    return str.split("\n").length - 1;
  }

  var processedCodeBlocks: Array<CodeBlock> = [];

  codeBlocks.forEach((block) => {
    var wrapper: { leading: string; trailing: string };
    switch (block.kind) {
      case "expr":
        wrapper = { leading: "fn init {println({\n", trailing: "\n})}\n" };
        break;
      case "no-check":
        return;
      case "enclose":
        wrapper = { leading: "fn init {\n", trailing: "\n}\n" };
        break;
      default:
        wrapper = { leading: "", trailing: "" };
        break;
    }

    const leadingLines = countLines(wrapper.leading);
    const contentLines = countLines(block.content);
    const trailingLines = countLines(wrapper.trailing);

    sourceMap.push({
      originalLine: block.beginLine + 1, // 1 based line number in markdown
      generatedLine: line + leadingLines, // 1 based line number in the generated mbt source
    });

    sourceMap.push({
      originalLine: block.endLine - 1,
      generatedLine: line + leadingLines + contentLines,
    });

    line += leadingLines + contentLines + trailingLines;
    block.content =
      wrapper.leading +
      (block.kind == "expr" || block.kind == "enclose"
        ? block.content.replace(/^/gm, "  ")
        : block.content) +
      wrapper.trailing;
    processedCodeBlocks.push(block);
  });

  // map location to real location in markdown
  function getRealLine(sourceMap: Array<LocationMapping>, line: number) {
    function find(line: number, l: number, r: number) {
      if (l >= r) return sourceMap[l];
      var m = Math.floor((l + r) / 2);
      const currentLine = sourceMap[m].generatedLine;
      if (currentLine > line) return find(line, l, m - 1);
      if (currentLine < line) return find(line, m + 1, r);
      return sourceMap[m];
    }
    const { originalLine, generatedLine } = find(line, 0, sourceMap.length - 1);
    return originalLine + (line - generatedLine);
  }

  const source = processedCodeBlocks.reduce(
    (acc, { content }) => acc + content,
    ""
  );

  // create a temporary project to run type checking and testing
  const projectPath = makeTempProject(basename(inputFile, ".md"));
  writeFileSync(join(projectPath, "main.mbt"), source, "utf-8");

  // run moon test
  const checkOutput = executeCommandLine(
    projectPath,
    `moon check --output-json -q`
  );

  const errList = checkOutput
    .replace(/error: failed when checking.*\n/, "")
    .split("\n")
    .map((err) => {
      return JSON.parse(err) as Diagnostic;
    });

  for (const err of errList) {
    const { level, loc, message, error_code } = err;
    const { path, start, end } = loc;
    if (globalWarningsSuppressed && level == "warning") {
      continue;
    }
    if (errSet.has(error_code)) {
      continue;
    }
    const errLvl =
      level == "error"
        ? "\x1b[1;31mError\x1b[0m"
        : "warning"
        ? "\x1b[1;33mWarning\x1b[0m"
        : level;
    const errCode = `\x1b[31m[E${error_code}]\x1b[0m`;
    const realBeginLine = getRealLine(sourceMap, start.line);
    const realEndLine = getRealLine(sourceMap, end.line);
    const errMsg = message.replace(
      new RegExp(path + ":(\\d+):(\\d+)"),
      (_, l, c) =>
        `\x1b[4;37m${inputFile}:${getRealLine(
          sourceMap,
          parseInt(l)
        )}:${c}\x1b[0m`
    );

    console.log(
      `\x1b[4;37m${inputFile}:${
        realBeginLine == realEndLine
          ? realBeginLine + ":" + start.col
          : realBeginLine + ":" + start.col + "-" + realEndLine + ":" + end.col
      }\x1b[0m\n${errCode}\t${errLvl}: ${errMsg}`
    );
  }

  // dump generated code
  if (cli.values.dump) {
    writeFileSync(inputFile + ".mbt", source, "utf-8");
  }

  // cleanup the temporary project
  temp.cleanupSync();
}

if (hasErrors) {
  process.exit(1);
} else {
  process.exit(0);
}
