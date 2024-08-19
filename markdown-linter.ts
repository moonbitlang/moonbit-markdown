#!/usr/bin/env node
// @ts-check
/*
 *   Markdown linter for MoonBit.
 *   Usage: node markdown_linter.js [args] <inputFiles>
 */
import * as MarkdownIt from "markdown-it";
import { execSync } from "node:child_process";
import {
  cpSync,
  readFileSync,
  rmSync,
  writeFile,
  writeFileSync,
} from "node:fs";
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
      default: false,
      description: "Ignore error codes from codeblocks",
    },
  },
  allowPositionals: true,
});

if (cli.values.help) {
  console.log(`
Usage: mdlint [args] <inputFiles>

Options:
  -h, --help                      Display this help message and exit
  -v, --version                   Display version information and exit
  -d, --dump                      Dump generated moon source project
  -s, --suppress | <list>         Suppress warnings from given comma-separated list
                 | all-warnings   Suppress all warnings
  -i, --ignore                    Ignore error codes from codeblocks

Example:
  mdlint README.md -d -s=e1001,e1002
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
      cli.values.suppress
        .replace("=", "")
        .split(",")
        .map((s) => parseInt(s.substring(1)))
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
    return error.stdout.trim();
  }
}

function removeFiles(...paths: string[]) {
  try {
    paths.forEach((path) => {
      rmSync(path);
    });
  } catch (error) {
    console.log("Error: " + error.message);
  }
}

function makeTempProject(projectName) {
  const projectPath = temp.mkdirSync();
  // writeFileSync(
  //   join(projectPath, "/moon.mod.json"),
  //   `{ "name": "${projectName}" }`,
  //   "utf-8"
  // );
  // writeFileSync(join(projectPath, "/moon.pkg.json"), `{}`, "utf-8");
  executeCommandLine(projectPath, `moon new ${projectName} --no-license --lib`);
  const basepath = join(projectPath, projectName, "src");
  try {
    removeFiles(
      join(basepath, "top.mbt"),
      join(basepath, "lib", "hello.mbt"),
      join(basepath, "lib", "hello_test.mbt")
    );
  } catch (error) {
    console.log("Error: " + error.message);
  }
  return basepath;
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
  fileBelonged: string;
};

function processMarkdown(inputFile) {
  const readmeFilename = basename(inputFile);
  const readme = readFileSync(inputFile, "utf-8");

  // parse readme and find codeblocks
  const tokens = md.parse(readme, {});
  const codeBlocks: Array<CodeBlock> = [];
  const projectPath = makeTempProject(basename(inputFile, ".md"));
  tokens.forEach((token, index) => {
    const codeInfo = token.info.trim();
    if (
      codeInfo.toLowerCase().startsWith("mbt") ||
      codeInfo.toLowerCase().startsWith("moonbit")
    ) {
      const info = codeInfo.split(" ").map((s) => s.trim());
      var kind;
      var fileBelonged: string = "top.mbt";
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
        {
          if (cli.values.ignore == false)
            info.forEach((arg) => {
              const errCodes = arg.match(/(?<=-e)\d+/gi);
              errCodes?.forEach((errCode) => errSet.add(parseInt(errCode)));
            });
        }
        info.forEach((arg) => {
          const fileNames = arg.match(/(?<=-f=).*mbt/gi);
          fileBelonged = fileNames ? basename(fileNames[0]) : fileBelonged;
        });
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
          fileBelonged: fileBelonged,
        });
      }
    }
  });

  // generate source map
  const sourceMap: Map<string, Array<LocationMapping>> = new Map();
  const line: Map<string, number> = new Map();

  function countLines(str: string) {
    return str.split("\n").length - 1;
  }

  const processedCodeBlocks: Map<string, Array<CodeBlock>> = new Map();

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

    line.set(block.fileBelonged, line.get(block.fileBelonged) || 1); // set default line number

    // initialize source map and processed code blocks
    sourceMap.set(
      block.fileBelonged,
      sourceMap.get(block.fileBelonged) || new Array<LocationMapping>()
    );
    processedCodeBlocks.set(
      block.fileBelonged,
      processedCodeBlocks.get(block.fileBelonged) || new Array<CodeBlock>()
    );

    const leadingLines = countLines(wrapper.leading);
    const contentLines = countLines(block.content);
    const trailingLines = countLines(wrapper.trailing);

    sourceMap.get(block.fileBelonged)!.push({
      originalLine: block.beginLine + 1, // 1 based line number in markdown
      generatedLine: line.get(block.fileBelonged)! + leadingLines, // 1 based line number in the generated mbt source
    });

    sourceMap.get(block.fileBelonged)!.push({
      originalLine: block.endLine - 1,
      generatedLine:
        line.get(block.fileBelonged)! + leadingLines + contentLines,
    });

    line.set(
      block.fileBelonged,
      line.get(block.fileBelonged)! +
        leadingLines +
        contentLines +
        trailingLines
    );
    block.content =
      wrapper.leading +
      (block.kind == "expr" || block.kind == "enclose"
        ? block.content.replace(/^/gm, "  ")
        : block.content) +
      wrapper.trailing;
    processedCodeBlocks.get(block.fileBelonged)!.push(block);
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

  const source: Map<string, string> = new Map();

  for (const [fileName, CodeBlocks] of processedCodeBlocks) {
    const sourceCode = CodeBlocks.reduce(
      (acc, { content }) => acc + content,
      ""
    );
    source.set(fileName, sourceCode);
  }

  // create a temporary project to run type checking and testing
  source.forEach((s, fileName) => {
    if (fileName == "top.mbt") {
      writeFileSync(join(projectPath, fileName), s, "utf-8");
    } else {
      writeFileSync(join(projectPath, "lib", fileName), s, "utf-8");
    }
  });

  // run moon test
  const checkOutput = executeCommandLine(
    projectPath,
    `moon check --output-json`
  );

  const errList = checkOutput
    .split("\n")
    .map((err) => {
      try {
        return JSON.parse(err) as Diagnostic;
      } catch (error) {
        return null;
      }
    })
    .filter((err) => err != null);

  console.log("Supressed: " + Array.from(errSet));
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
    const realBeginLine = getRealLine(
      sourceMap.get(basename(path))!,
      start.line
    );
    const realEndLine = getRealLine(sourceMap.get(basename(path))!, end.line);
    const errMsg = message.replace(
      new RegExp(path + ":(\\d+):(\\d+)"),
      (_, l, c) =>
        `\x1b[4;37m${inputFile}:${getRealLine(
          sourceMap.get(basename(path))!,
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
    // writeFileSync(inputFile + ".mbt", source, "utf-8");
    cpSync(projectPath, inputFile + ".proj", { recursive: true });
  }

  // cleanup the temporary project
  temp.cleanupSync();
}

if (hasErrors) {
  process.exit(1);
} else {
  process.exit(0);
}
