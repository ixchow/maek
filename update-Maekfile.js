"use strict";
//Usage:
// node update-Maekfile.js <path/to/Maekfile.js>
//update target Maekfile.js with the init_make and preamble
//from the Maekfile.js is this directory.

if (process.argv.length !== 3) {
	console.log("Usage:\n" +
	            "    node update-Maekfile.js <path/to/Maekfile.js>\n" +
	            "update target Maekfile.js with the init_make and preamble\n" +
	            "from the Maekfile.js is this directory.");
	process.exit(1);
}

const fs = require('fs');

const sourceFile = `${__dirname}/Maekfile.js`;
const targetFile = process.argv[2];
console.log(`Updating ${targetFile} with code from ${sourceFile}...`);

const sourceText = fs.readFileSync(sourceFile, {encoding: 'utf8'});
const targetText = fs.readFileSync(targetFile, {encoding: 'utf8'});

const divider = '//' + '='.repeat(70) + '\n';

const sourceSplit = sourceText.split(divider);
const targetSplit = sourceText.split(divider);

if (sourceSplit.length !== 3) {
	console.error("Maekfile.js in this directory doesn't have exactly two '='*72 division comments.");
	process.exit(1);
}

if (targetSplit.length !== 3) {
	console.error("Target Maekfile.js doesn't have exactly two '='*72 division comments.");
	process.exit(1);
}

const finalText = sourceText[0] + divider + targetText[1] + divider + sourceText[2];

fs.writeFileSync(targetFile, finalText, {encoding: 'utf8'});

console.log("   done (but remember to check `git diff` and if the project builds).");
