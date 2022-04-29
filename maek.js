
/*
 * This is "Maek" a simple build system designed to be transparent and hackable.
 * It is written in Node -- https://nodejs.org/.
 *
 * Usage:
 *  node maek.js [target1] [target2] ...
 *
 * If no target is given, maek will build the first target in its list.
 *
 * To learn more, read onward!
 */

/*
 * Maek runs tasks to produce targets.
 *
 * Targets are strings and are either:
 *  - files (strings that look like 'path/to/file')
 *  - abstract (strings that start with ':', e.g. ':dist')
 *
 * Tasks are javascript objects with a:
 *  - 'targets' array: what targets the task will build
 *  - 'prerequisites' array: what targets must be up-to-date before the task is run
 *  - 'run' async function: (optional) called to build targets from prerequisites. throws on error.
 *  - 'expand' async function: (optional): called to add to prerequisites array. throws on error
 *
 * file-type targets are 'up-to-date' if:
 *  - they exist and
 *    - they aren't the target of any task
 *       (or)
 *    - the task that targets them is 'up-to-date'
 *
 * TODO: abstract targets are 'up-to-date' ... when?
 *
 * tasks are 'up-to-date' if:
 *  - all the prerequisites are 'up-to-date'
 *  - the task has been run since the prerequisites were brought 'up-to-date'
 *
 * Task execution works as follows:
 *  - bring all prerequisites up-to-date
 *  - execute 'task.expand'
 *  - bring any newly listed prerequisites up-to-date
 *  - execute 'task.run'
 */


//Several helper functions (defined below) exist to construct basic tasks:
//CPP_task("foo.cpp") builds "foo${SUF.obj}" from "foo.cpp"
//LINK_task("dist/game", ["foo", "bar", "baz"]
const CPP = {};
const LINK = {};

//SUF has file extension shortcuts to make it easier to write various rules:
//SUF.exe is '.exe' on windows; '' on macos + linux
//SUF.obj is '.obj' on windows; '.o' on macos + linux
const SUF = {}; //properties set per-OS in init()

init(); //sets up CPP, LINK, SUF

const RULES = [
	{ //':dist' abstract target includes executable and all assets:
		targets:[":dist"],
		prerequisites:[`dist/game${SUF.exe}`]
	},
	{ //rule to link game executable:
		targets:[`dist/game${SUF.exe}`],
		prerequisites:[`objs/game${SUF.obj}`, `objs/player${SUF.obj}`],
		recipe:LINK
	},
	{ //generic rule to build cpp files:
		targets:[`objs/%${SUF.obj}`],
		prerequisites:[`%.cpp`],
		recipe:CPP
	},
	{ //rule to link testing executable:
		targets:[`test/game-test${SUF.exe}`],
		prerequisites:[`objs/test${SUF.obj}`,`objs/player${SUF.obj}`],
		recipe:LINK
	},
	{ //':test' abstract target runs tests:
		targets:[`:test`],
		prerequisites:[`test/game-test${SUF.exe}`],
		recipe:{
			run:(context) => {
				for (let test of context.prerequisites) {
					run_always(test);
				}
			}
		}
	}
];

//-------------------------------------------------------------
//Rule execution logic:

let pending = {}; //map from target name => promise

//return promise that will resolve when target is updated:
function updateTarget(target) {
	//if target isn't already pending, build promise that will update it:
	if (!(target in pending)) {
		const rule = findRule(target);
		//Register rule-update promise for
		// *all* targets of that rule:
		const promise = updateRule(rule);
		for (const t of rule.targets) {
			if (t in pending) {
				throw new Error(`Multiple rules target '${target}'!`);
			}
			pending[t] = promise;
		}
	}
	//return promise that updates target:
	return pending[target];
}

//async function that creates a promise that resolves when target is updated:
async function updateRule(rule) {
	//for a rule to be up-to-date, all prerequisite targets must be up-to-date:
	await Promise.all(rule.prerequisites.map(updateTarget));

	//if rule's recipe has 'expand' function, run it and re-update prerequisites:
	if ('recipe' in rule && 'expand' in rule.recipe) {
		await rule.recipe.expand(rule);
		await Promise.all(rule.prerequisites.map(updateTarget));
	}

	//if rule's recipe has 'run' function, run it to generate targets:
	if ('recipe' in rule && 'run' in rule.recipe) {
		await rule.recipe.run(rule);
	}
	
	//verify that all file-like targets of the rule exist:
	let checks = [];
	for (const t of rule.targets) {
		checks.push(async () => {
			try {
				await fsPromises.access(t, fsPromises.constants.R_OK);
			} catch (e) {
				throw new Error(`Rule promised to make '${t}', but file does not exist.`);
			}
		});
	}
	await Promise.all(checks);
}

//find rule that matches target:
function findRule(target) {
	//TODO: wildcard rules

	//return first rule that mentions target:
	for (const rule of RULES) {
		for (const t of rule.targets) {
			if (t === target) {
				return rule;
			}
		}
	}

	//no rule matches, so make up a rule that just requires the file to exist:
	return {
		targets:[target],
		prerequisites:[],
		recipe:{
			type:"EXISTS",
			run:async (rule) => {
				const target = rule.targets[0];
				//file-like?
				if (target[0] === ':') {
					throw new Error(`No rule to bring abstract target '${target}' up-to-date.`);
				}
				//exists?
				try {
					await fsPromises.access(target, fsPromises.constants.R_OK);
				} catch (e) {
					throw new Error(`Target '${target}' does not exist and no rule creates it.`);
				}
			}
		}
	};
}


//-------------------------------------------------------------

const path = require('path').posix; //use the posix-style functions on all platforms
const fsPromises = require('fs/promises');
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);

//--------------------------------------------------------------
//initialization dragged down here so the rules (which you probably edit more) stay up there:
function init() {

	console.log("This is Maek v0.0, in yer computer, building yer code.");
	const os = require('os');
	const platform = os.platform();
	console.log(`  platform: ${platform}`);

	if (platform === 'win32') {
		SUF.exe = '.exe';
		SUF.obj = '.obj';

		CPP.build = async (rule) => { throw new Error("TODO: CPP rule on win32"); };
		LINK.build = async (rule) => { throw new Error("TODO: LINK rule on win32"); };
	} else if (platform === 'linux') {
		SUF.exe = '';
		SUF.obj = '.o';

		//set up CPP rule:
		const CC = 'g++';
		const CC_ARGS = ['-std=c++20', '-g', '-Wall', '-Werror'];
		CPP.build = async (rule) => {
			check(rule.targets.length === 1, "CPP recipe expects a single target.");
			check(rule.prerequisites.length >= 1, "CPP recipe expects at least one prerequisite.");
			const target = rule.targets[0];
			const source = rule.source[0];
			await run(CC, [...CC_ARGS, '-c', target, source], {message:`CPP: Building '${target}' from '${source}'...`});
		};
		CPP.expand = async (rule) => {
			const source = rule.source[0];
			cache
		};

		const LINK = 'g++';
		const LINK_ARGS = ['-std=c++20', '-g', '-Wall', '-Werror'];

	} else if (platform === 'darwin') {
		SUF.exe = '';
		SUF.obj = '.o';

		CPP.build = async (rule) => { throw new Error("TODO: CPP rule on darwin"); };
		LINK.build = async (rule) => { throw new Error("TODO: LINK rule on darwin"); };
	} else {
		console.log(`Platform "${platform}" is not currently supported.`);
		process.exit(1);
	}
}

//-------------------------------------------------------------
//helpers for dealing with targets:
async function is_changed(file) {
	return true;
}

async function run(file, args, {message}) {
	process.stdout.write(message);

}
//runs file with arguments in args,
// except if all of the files in 'writes' exist and all of the files in 'reads' are unchanged.
async function run_cached(file, args, {message, reads, writes}) {
	//TODO: caching!
	return execFile(file, args);
}
function check(condition, message) {
	if (!condition) throw new Error(message);
}


//-------------------------------------------------------------
//Code that runs the rules in some valid order:


async function build(targets) {
	console.log("Building: ", targets);
	try {
		await Promise.all(targets.map(updateTarget));
	} catch (e) {
		console.error(e);
	}
}

build(RULES[0].targets);

//okay, so, um, dependancy graph I guess is a thing?

//(1) build dependency graph from explicit prerequisites
//(2) add to these 
