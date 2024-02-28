#!/usr/bin/env node
/*
 *   Markdown linter for MoonBit.
 *   Usage: node markdown_linter.js <inputFile>
 */
const { parseArgs } = require("node:util");
const options = {
  version: {
    type: "boolean",
    short: "v",
  },
};

const cli = parseArgs({
  options: options,
  allowPositionals: true,
});

if (cli.values.version) {
  console.log(`Markdown linter ${require("./package.json").version}`);
  process.exit(0);
}

const files = cli.positionals;
const MarkdownIt = require("markdown-it");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const temp = require("temp").track();

const md = new MarkdownIt();

// const [, , inputFile] = process.argv;
for (const inputFile of files) {
  process(inputFile);
}

function process(inputFile) {
  const readmeFilename = path.basename(inputFile);
  const readme = fs.readFileSync(inputFile, "utf-8");

  // parse readme and find codeblocks
  const tokens = md.parse(readme,{});
  var codeBlocks = [];

  tokens.forEach((token, index) => {
    const codeType = token.info.trim().toLowerCase();
    if (codeType.startsWith("mbt") || codeType.startsWith("moonbit")) {
      const { content, map } = token;
      codeBlocks.push({ content, beginLine: map[0] + 1, endLine: map[1] + 1 });
    }
  });

  // generate source map
  sourceMap = [];
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

  // call moonc to compile the code
  function executeCommandLine(command) {
    try {
      const output = execSync(command, { encoding: "utf-8", stdio: "pipe" });
      return output.trim();
    } catch (error) {
      return error.stderr.trim();
    }
  }

  const source = codeBlocks.reduce((acc, { content }) => acc + content, "");
  const tempFile = temp.openSync({ suffix: ".mbt" }).path;
  fs.writeFileSync(tempFile, source, "utf-8");
  const compileOutput = executeCommandLine(`moonc compile ${tempFile}`);
  temp.cleanupSync();

  // process the diagnostics
  const diagnosticPattern = /\b(.+\.mbt):(\d+):(\d+)-(\d+):(\d+)/g;

  const diagnostics = compileOutput.replace(
    diagnosticPattern,
    (_, file, beginLine, beginColumn, endLine, endColumn) => {
      const realBeginLine = getRealLine(sourceMap, parseInt(beginLine));
      const realEndLine = getRealLine(sourceMap, parseInt(endLine));
      return `${readmeFilename}:${realBeginLine}:${beginColumn}-${realEndLine}:${endColumn}`;
    }
  );

  console.log(diagnostics);
}
