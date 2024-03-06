#!/usr/bin/env node
// @ts-check
/*
 *   Markdown linter for MoonBit.
 *   Usage: node markdown_linter.js <inputFile>
 */
const { parseArgs } = require("node:util");

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
const MarkdownIt = require("markdown-it");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const temp = require("temp").track();

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
  fs.writeFileSync(path.join(projectPath, "/moon.mod.json"), `{ "name": "${projectName}" }`, "utf-8");
  fs.writeFileSync(path.join(projectPath, "/moon.pkg.json"), `{}`, "utf-8");
  return projectPath;
}

function processMarkdown(inputFile) {
  const readmeFilename = path.basename(inputFile);
  const readme = fs.readFileSync(inputFile, "utf-8");

  // parse readme and find codeblocks
  const tokens = md.parse(readme, {});
  var codeBlocks = [];

  tokens.forEach((token, index) => {
    const codeType = token.info.trim().toLowerCase();
    if (codeType.startsWith("mbt") || codeType.startsWith("moonbit")) {
      const { content, map } = token;
      if (map) {
        codeBlocks.push({ content, beginLine: map[0] + 1, endLine: map[1] + 1 });
      }
    }
  });

  // generate source map
  var sourceMap = [];
  var line = 1;
  codeBlocks.forEach(({ content, beginLine, endLine }) => {
    sourceMap.push({
      original: beginLine + 1, // 1 based line number in markdown
      generated: line, // 1 based line number in the generated mbt source
    });
    line += content.split("\n").length - 1;
    sourceMap.push({ original: endLine - 1, generated: line });
  });

  // map location to real location in markdown
  function getRealLine(sourceMap, line) {
    function find(line, l, r) {
      if (l > r) return sourceMap[l];
      var m = Math.floor((l + r) / 2);
      const currentLine = sourceMap[m].generated;
      if (currentLine > line) return find(line, l, m - 1);
      if (currentLine < line) return find(line, m + 1, r);
      return sourceMap[m];
    }
    const { original, generated } = find(line, 0, sourceMap.length);
    return original + (line - generated);
  }

  const source = codeBlocks.reduce((acc, { content }) => acc + content, "");

  // create a temporary project to run type checking and testing
  const projectPath = makeTempProject(path.basename(inputFile, ".md"));
  fs.writeFileSync(path.join(projectPath, "main.mbt"), source, "utf-8");

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
        return `${readmeFilename}:${realBeginLine}:${beginColumn}-${realEndLine}:${endColumn}`;
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
