#!/usr/bin/env node
// @ts-check
/*
 *   Markdown linter for MoonBit.
 *   Usage: node markdown_linter.js <inputFile>
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
    },
  },
  allowPositionals: true,
});

if (cli.values.version) {
  console.log(`Markdown linter ${require("./package.json").version}`);
  globalThis.process.exit(0);
}

const files = cli.positionals;
const temp = track();

const md = new MarkdownIt();
var hasErrors = false;

for (const inputFile of files) {
  processMarkdown(inputFile);
}

function executeCommandLine(workingDir, command) {
  try {
    const output = execSync(command, { encoding: "utf-8", stdio: "pipe", cwd: workingDir });
    return output.trim();
  } catch (error) {
    return error.stdout.trim() + error.stderr.trim();
  }
}

function makeTempProject(projectName) {
  const projectPath = temp.mkdirSync();
  writeFileSync(join(projectPath, "/moon.mod.json"), `{ "name": "${projectName}" }`, "utf-8");
  writeFileSync(join(projectPath, "/moon.pkg.json"), `{}`, "utf-8");
  return projectPath;
}

type LocationMapping = {
  originalLine : number;
  generatedLine : number;
};

type CodeBlock = {
  content: string;
  kind: "normal" | "expr" | "no-check";
  beginLine : number;
  endLine : number;
};

function processMarkdown(inputFile) {
  const readmeFilename = basename(inputFile);
  const readme = readFileSync(inputFile, "utf-8");

  // parse readme and find codeblocks
  const tokens = md.parse(readme, {});
  var codeBlocks : Array<CodeBlock> = [];

  tokens.forEach((token, index) => {
    const codeInfo = token.info.trim()

    if (codeInfo.toLowerCase().startsWith("mbt") || codeInfo.toLowerCase().startsWith("moonbit")) {
      const info = codeInfo.split(" ").map(s => s.trim());
      var kind;
      if (info.length > 1) {
        switch (info[1].toLowerCase()) {
          case "expr":
            kind = "expr";
            break;
          case "no-check":
            kind = "no-check";
            break;
          default:
            kind = "normal";
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
          endLine: map[1] + 1
        });
      }
    }
  });


  // generate source map
  var sourceMap : Array<LocationMapping> = [];
  var line = 1;

  function countLines(str : string) {
    return str.split("\n").length - 1;
  }


  var processedCodeBlocks : Array<CodeBlock> = []

  codeBlocks.forEach(block => {
    var wrapper : { leading: string, trailing: string };
    switch (block.kind) {
      case "expr":
        wrapper = { leading: "fn init {debug({\n", trailing: "\n})}\n" };
        break;
      case "no-check":
        return;
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
      generatedLine: line + leadingLines + contentLines
    });

    line += leadingLines + contentLines + trailingLines;
    block.content = wrapper.leading + block.content + wrapper.trailing;
    processedCodeBlocks.push(block);
  });

  // map location to real location in markdown
  function getRealLine(sourceMap : Array<LocationMapping>, line : number) {
    function find(line : number, l : number, r : number) {
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

  const source = processedCodeBlocks.reduce((acc, { content }) => acc + content, "");

  // create a temporary project to run type checking and testing
  const projectPath = makeTempProject(basename(inputFile, ".md"));
  writeFileSync(join(projectPath, "main.mbt"), source, "utf-8");

  // run moon test
  const checkOutput = executeCommandLine(projectPath, `moon test`);

  // cleanup the temporary project
  temp.cleanupSync();

  // process the diagnostics
  const diagnosticPattern = /^(.+\.mbt):(\d+):(\d+)-(\d+):(\d+)/gm;
  const moonFailedPattern = /failed: moonc .+\n/g;

  const diagnostics = checkOutput
    .replace( // replace location with real location in markdown
      diagnosticPattern,
      (_, file, beginLine, beginColumn, endLine, endColumn) => {
        const realBeginLine = getRealLine(sourceMap, parseInt(beginLine));
        const realEndLine = getRealLine(sourceMap, parseInt(endLine));
        const fullPath = join(process.cwd(), inputFile);
        return `${fullPath}:${realBeginLine}:${beginColumn}-${realEndLine}:${endColumn}`;
      }
    )
    .replace( // remove unused output
      moonFailedPattern,
      _ => {
        hasErrors = true;
        return ""
      }
    )

  console.log(diagnostics);
}

if (hasErrors) {
  process.exit(1)
} else {
  process.exit(0)
}
