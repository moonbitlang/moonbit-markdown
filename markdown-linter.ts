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
  origin: CodeBlock;
  generatedLine: number;
  generatedColumn: number;
};

type CodeBlock = {
  content: string;
  kind: "normal" | "expr" | "no-check";
  beginLine: number;
  endLine: number;
};

function processMarkdown(inputFile) {
  const readme = readFileSync(inputFile, "utf-8");

  // parse readme and find codeblocks
  const tokens = md.parse(readme, {});
  var codeBlocks: Array<CodeBlock> = [];

  tokens.forEach((token) => {
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
          beginLine: map[0] + 2, // 1 based line number in markdown + fence line
          endLine: map[1] + 1
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


  var processedCodeBlocks: Array<CodeBlock> = []

  codeBlocks.forEach(block => {
    var wrapper: { leading: string, trailing: string };
    var generatedColumn = 0;
    switch (block.kind) {
      case "expr":
        wrapper = { leading: "fn init { {\n", trailing: "\n} |> debug }\n" };
        generatedColumn = 2;
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
      origin: block,
      generatedLine: line + leadingLines, // 1 based line number in the generated mbt source
      generatedColumn
    });

    line += leadingLines + contentLines + trailingLines;
    block.content = wrapper.leading + block.content.replace(/^/gm, " ".repeat(generatedColumn)) + wrapper.trailing;
    processedCodeBlocks.push(block);
  });

  // map location to real location in markdown
  function resolveMapping(sourceMap: Array<LocationMapping>, line: number, column: number): { column: number, line: number } {
    let left = 0;
    let right = sourceMap.length - 1;
    let index = -1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (sourceMap[mid].generatedLine <= line) {
        index = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    if (index === -1) {
      index = sourceMap.length - 1;
    }

    const { origin, generatedLine, generatedColumn } = sourceMap[index];
    return {
      line: origin.beginLine + (line - generatedLine),
      column: column - generatedColumn
    };
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
        const { line: realBeginLine, column: realBeginColumn } = resolveMapping(sourceMap, parseInt(beginLine), parseInt(beginColumn));
        const { line: realEndLine, column: realEndColumn } = resolveMapping(sourceMap, parseInt(endLine), parseInt(endColumn));
        const fullPath = join(process.cwd(), inputFile);
        if (realBeginLine === realEndLine) {
          return `${fullPath}:${realBeginLine}:${realBeginColumn}-${realEndColumn}`;
        } else {
          return `${fullPath}:${realBeginLine}:${realBeginColumn}-${realEndLine}:${realEndColumn}`;
        }
        
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
