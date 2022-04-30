//Run this (javascript) file with node:
//$ node maek.js [target1] [target2] [...]

//set up the build:
// (it's a quirk of javascript that function definitions anywhere in scope get 'hoisted'
//   -- you can see the definition of init_build by scrolling down.)
const maek = init_maek();

//call rules on the build object to specify tasks.
// rules generally look like:
//  output = maek.RULE_NAME(input [, output] [, {options}])

//the '[objFile =] CPP(cppFile [, objFileBase] [, options])' compiles a c++ file:
// cppFile: name of c++ file to compile
// objFileBase (optional): base name object file to produce (if not supplied, set to options.objDir + '/' + cppFile without the extension)
//returns objFile: objFileBase + a platform-dependant suffix ('.o' or '.obj')
const Player_obj = maek.CPP('Player.cpp');
const Level_obj = maek.CPP('Level.cpp');
const game_obj = maek.CPP('game.cpp');
const test_obj = maek.CPP('test.cpp');

//the '[exeFile =] LINK(objFiles, exeFileBase, [, options])' links an array of objects into an executable:
// objFiles: array of objects to link
// exeFileBase: name of executable file to produce
//returns exeFile: exeFileBase + a platform-dependant suffix (e.g., '.exe' on windows)
const game_exe = maek.LINK([game_obj, Player_obj, Level_obj], 'dist/game');
const test_exe = maek.LINK([test_obj, Player_obj, Level_obj], 'test/game-test');

//the '[targets =] RULE(targets, prerequisites[, recipe])' rule defines a Makefile-style task
// targets: array of targets the task produces (can include both files and ':abstract targets')
// prerequisites: array of targets the task waits on (can include both files and ':abstract targets')
// recipe (optional): array of commands to run (where each command is an array [exe, arg1, arg0, ...])
//returns targets: the targets the rule produces
maek.RULE([':test'], [test_exe], [
	[test_exe, '--all-tests']
]);

//Note that tasks that produce ':abstract targets' are never cached.
// This is similar to how .PHONY targets behave in make.

// - - - - - - - - - - - - - - - - - - - - - - - - -
//Now that the tasks are specified, decide which targets to build:

//by default, build the ':dist' abstract target:
let targets = [':dist'];

//but if anything is on the command line, build that instead:
if (process.argv.length > 2) {
	targets = process.argv.slice(2);
}

//note: this is an async function...
maek.update(targets);
//...which means it's not actually done here.
// (but node will wait until the function is done to exit)



//--------------------------------------------------------
//Now, onward to the code that makes all this work:
//  (edit this if you need to support new compilers or noodle with flags)

function init_maek() {
	//standard libraries:
	const path = require('path').posix; //NOTE: expect posix-style paths even on windows
	const fsPromises = require('fs/promises');
	const fs = require('fs');

	//make it so that all paths/commands are relative to Maekfile.js:
	// (regardless of where you run it from)
	process.chdir(__dirname);

	//will fill in properties on this object with the public interface
	// to the build system and then return it:
	const maek = {};

	//-----------------------------------------
	//Constants:

	//cache file location:
	const CACHE_FILE = 'maek-cache.json';

	//current OS: (with slightly nicer naming than os.platform()
	const OS = (()=>{
		const platform = require('os').platform();
		if      (platform === 'win32' ) return 'windows';
		else if (platform === 'darwin') return 'macos';
		else if (platform === 'linux' ) return 'linux';
		else {
			console.error(`ERROR: Unrecognized platform ${os.platform()}.`);
			process.exit(1);
		}
	})();
	maek.OS = OS;

	const JOBS = require('os').cpus().length + 1;

	//-----------------------------------------
	//options: set to change maek rule behavior

	const DEFAULT_OPTIONS = {
		objPrefix:'objs/', //prefix for object file paths (if not explicitly specified)
		objSuffix:(OS === 'windows' ? '.obj' : '.o'), //suffix for object files
		exeSuffix:(OS === 'windows' ? '.exe' : ''), //suffix for executable files
		depends:[], //extra dependencies; generally only set locally
		CPPFlags:[], //extra flags for c++ compiler
		LINKLibs:[], //extra -L and -l flags for linker
	};

	//any settings here override 'DEFAULT_OPTIONS':
	maek.options = Object.assign({}, DEFAULT_OPTIONS); //shallow copy of DEFAULT_OPTIONS in case you want to console.log(maek.options) to check settings.

	//this combines DEFAULT_OPTIONS, maek.options, and localOptions:
	function combineOptions(localOptions) {
		//shallow copy of default options:
		const combined = Object.assign({}, DEFAULT_OPTIONS);
		//override with maek.options + complain on missing keys:
		for (const key of Object.keys(maek.options)) {
			if (!(key in combined)) throw new Error(`ERROR: '${key}' (in maek.options) not recognized.`);
			combined[key] = maek.options[key];
		}
		//override with localOptions + complain on missing keys:
		for (const key of Object.keys(localOptions)) {
			if (!(key in combined)) throw new Error(`ERROR: '${key}' (in local options) not recognized.`);
			combined[key] = localOptions[key];
		}
		return combined;
	}

	//-----------------------------------------
	//Data:

	//maek.tasks is a map from targets => tasks (possibly many-to-one):
	// a task is an async function that will make that target
	// (it will generally 'await' other tasks in the process)
	//
	// task.label is a human-readable name for the task (generally along the lines of "RULE 'source' -> 'target'")
	//
	// if task.keyFn is defined, it is used for caching (see below).
	// generally keyFn will return an array of the content hashes of all input and output files,
	// along with version information and parameters for external commands called by the script.
	maek.tasks = {};

	//during the build process some additional properties will be set on tasks:
	// task.cachedKey is used for caching:
	//  - after a task is run, the result of its keyFn is stored in cachedKey
	//  - a task will skipped if the result of its keyFn matches the result already in cachedKey
	//  comparisons are performed using: JSON.stringify(await task.keyFn()) === JSON.stringify(task.cachedKey)
	//
	// task.cachedKey values are loaded into the maek.tasks array from CACHE_FILE at the start of maek.update,
	// and stored into CACHE_FILE at the end of maek.update.
	//
	// task.pending is set by updateTargets() to keep track of currently-running task updates.

	//used to avoid re-hashing the same files a whole lot:
	const hashCache = {};
	let hashCacheHits = 0;

	//-----------------------------------------
	//Build rules add tasks to maek.tasks:

	//RULE adds a generic makefile-like task:
	// targets (array) are the things that get made
	// prerequisites (array) are the things that must be up-to-date before the recipe is run
	// recipe, optional (array) is a list of commands
	maek.RULE = (targets, prerequisites, recipe = []) => {
		if (!Array.isArray(targets)) throw new Error("RULE: targets must be an array.");
		if (!Array.isArray(prerequisites)) throw new Error("RULE: prerequisites must be an array.");
		if (!Array.isArray(recipe)) throw new Error("RULE: recipe must be an array.");

		const task = async () => {
			await updateTargets(prerequisites, `${task.label}`);
			let step = 1;
			for (const command of recipe) {
				await runCommand(command, `${task.label} (${step}/${recipe.length})`);
				step += 1;
			}
			for (const target of targets) {
				delete hashCache[target];
			}
		};

		if (!targets.some(target => target[0] === ':')) { //(don't cache RULE's with abstract targets)
			task.keyFn = async () => {
				await updateTargets(prerequisites, `${task.label} (keyFn)`); //prerequisites need to be ready before they can be hashed!
				return [
					...recipe,
					...(await hashFiles([...targets, ...prerequisites]))
				];
			};
		}
		task.label = `RULE '${prerequisites.join("', '")}' -> '${targets.join("', '")}'`;

		for (const target of targets) {
			maek.tasks[target] = task;
		}
	};


	//maek.CPP makes an object from a c++ source file:
	// cppFile is the source file name
	// objFileBase (optional) is the output file (including any subdirectories, but not the extension)
	maek.CPP = (cppFile, objFileBase, localOptions = {}) => {
		//combine options:
		const options = combineOptions(localOptions);

		//if objFileBase isn't given, compute by trimming extension from cppFile and appending to objPrefix:
		if (typeof objFileBase === 'undefined') {
			objFileBase = path.relative('', options.objPrefix + cppFile.replace(/\.[^.]*$/,''));
		}

		//object file gets os-dependent suffix:
		const objFile = objFileBase + options.objSuffix;

		//computed dependencies go in a '.d' file stored next to the object file:
		const depsFile = objFileBase + '.d';

		//explicit dependencies: (implicit dependencies will be computed later)
		const depends = [cppFile, ...options.depends];

		let cc, depsCommand, objCommand;
		if (OS === 'linux') {
			cc = ['g++', '-std=c++20', '-Wall', '-Werror', '-g', ...options.CPPFlags];
			depsCommand = [...cc, '-E', '-M', '-MG', '-MT', 'x ', '-MF', depsFile, cppFile];
			objCommand = [...cc, '-c', '-o', objFile, cppFile];
		} else if (OS === 'macos') {
			cc = ['clang++', '-std=c++20', '-Wall', '-Werror', '-g', ...options.CPPFlags];
			depsCommand = [...cc, '-E', '-M', '-MG', '-MT', 'x ', '-MF', depsFile, cppFile];
			objCommand = [...cc, '-c', '-o', objFile, cppFile];
		} else {
			throw new Error(`TODO: write CPP rule for ${OS}.`);
		}

		//will be used by loadDeps to trim explicit dependencies:
		const inDepends = {};
		for (const d of depends) {
			inDepends[d] = true;
		}
		async function loadDeps() {
			let text;
			try {
				text = await fsPromises.readFile(depsFile, {encoding:'utf8'});
			} catch (e) {
				return [];
			}

			let tokens = [''];
			//split text into tokens (and undo any escaping):
			for (let i = 0; i < text.length; ++i) {
				if (text[i] === ' ' || text[i] === '\t' || text[i] === '\n') {
					//whitespace starts a new token:
					if (tokens[tokens.length-1] !== '') {
						tokens.push('');
					}
				} else if (text[i] === '$' && text[i+1] === '$') {
					//'$$' -> '$'
					tokens[tokens.length-1] += '$';
					++i;
				} else if (text[i] === '\\' && i+1 < text.length) {
					if (text[i+1] === '\n') {
						//ignore, the \n will be correctly treated as whitespace by next loop.
					} else {
						//add to token even if it's whitespace:
						++i;
						tokens[tokens.length-1] += text[i];
					}
				} else {
					tokens[tokens.length-1] += text[i];
				}
			}
			if (tokens[tokens.length-1] === '') tokens.pop();

			console.assert(tokens[0] === 'x');
			console.assert(tokens[1] === ':');

			tokens = tokens.slice(2).sort();

			//NOTE: might want to do some path normalization here!
			const extraDepends = tokens.filter(target => !(target in inDepends));

			return extraDepends;
		}

		//The actual build task:
		const task = async () => {
			//first, wait for any explicit prerequisites to build:
			await updateTargets(depends, `${task.label}`);
			//make object file:
			delete hashCache[objFile];
			await fsPromises.mkdir(path.dirname(objFile), {recursive:true});
			await runCommand(objCommand, `${task.label}: compile`);
			//make dependencies file: (NOTE: could do with same compile line)
			delete hashCache[depsFile];
			await fsPromises.mkdir(path.dirname(depsFile), {recursive:true});
			await runCommand(depsCommand,`${task.label}: prerequisites`);
			//read extra dependencies and make sure they aren't targets of other rules:
			const extraDepends = await loadDeps();
			assertNontargets(extraDepends, `${task.label}`);
			//NOTE: if dynamic prerequisites are targets of other tasks there is a
			// problem whereby Maek can't know proper rule sequencing until it
			// has already run a rule.
		};

		task.keyFn = async () => {
			await updateTargets(depends, `${task.label} (keyFn)`);
			const extraDepends = await loadDeps();
			assertNontargets(extraDepends, `${task.label}`);
			return [
				objCommand, depsCommand,
				...(await hashFiles([objFile, depsFile, ...depends, ...extraDepends]))
			];
		};

		task.label = `CPP '${depends.join("', '")}' -> '${objFile}'`;

		maek.tasks[objFile] = task;

		return objFile;
	};


	//maek.LINK links an executable file from a collection of object files:
	// objFiles is an array of object file names
	// exeFileBase is the base name of the executable file ('.exe' will be added on windows)
	maek.LINK = (objFiles, exeFileBase, localOptions={}) => {
		const options = combineOptions(localOptions);

		const exeFile = exeFileBase + options.exeSuffix;

		let link, linkCommand;
		if (OS === 'linux') {
			link = ['g++', '-std=c++20', '-Wall', '-Werror', '-g'];
			linkCommand = [...link, '-o', exeFile, ...objFiles, ...options.LINKLibs];
		} else if (OS === 'macos') {
			link = ['g++', '-std=c++20', '-Wall', '-Werror', '-g'];
			linkCommand = [...link, '-o', exeFile, ...objFiles, ...options.LINKLibs];
		} else {
			throw new Error(`TODO: write LINK rule for ${OS}.`);
		}
		const depends = [...objFiles, ...options.depends];

		const task = async () => {
			//first, wait for all requested object files to build:
			await updateTargets(depends, `${task.label}`);

			//then link:
			delete hashCache[exeFile];
			await fsPromises.mkdir(path.dirname(exeFile), {recursive:true});
			await runCommand(linkCommand, `${task.label}: link`);
		};

		task.keyFn = async () => {
			await updateTargets(depends, `${task.label} (keyFn)`);
			return [
				linkCommand,
				...(await hashFiles([exeFile, ...depends]))
			];
		};

		task.label = `LINK '${depends.join("', '")}' -> '${exeFile}'`;

		maek.tasks[exeFile] = task;

		return exeFile;
	};

	//---------------------------------
	//helper functions used by the build rules:

	class BuildError extends Error {
		constructor(message) {
			super(message);
		}
	}

	//updateTargets takes a list of targets and updates them as needed.
	async function updateTargets(targets, from) {
		const pending = [];
		for (const target of targets) {
			//if target has an associated task, wait on that task:
			if (target in maek.tasks) {
				const task = maek.tasks[target];
				// launch task if not already pending:
				if (!('pending' in task)) {
					task.from = from;
					task.pending = (async () => {
						try {
							//check for cache hit:
							if ('cachedKey' in task && 'keyFn' in task) {
								const key = await task.keyFn();
								if (JSON.stringify(key) === JSON.stringify(task.cachedKey)) {
									//TODO: VERBOSE: console.log(`${task.label}: already in cache.`);
									return;
								}
							}
							//on cache miss, run task:
							await task();
							//and update cache:
							if ('keyFn' in task) {
								task.cachedKey = await task.keyFn();
							}
						} catch (e) {
							if (e instanceof BuildError) {
								console.error(`FAILED: ${task.label} (requested by ${from}): ${e.message}`);
								throw new BuildError(`prerequisite failed.`);
							} else {
								throw e;
							}
						}
					})();
				}
				pending.push(task.pending);
			//otherwise, if target is abstract, complain because it isn't known:
			} else if (target[0] === ':') {
				throw new BuildError(`Target '${target}' (requested by ${from}) is abstract but doesn't have a task.`);
			//otherwise, target is a file, so check that it exists:
			} else {
				pending.push(
					fsPromises.access(target, fs.constants.R_OK).catch((e) => {
						throw new BuildError(`Target '${target}' (requested by ${from}) doesn't exist and doesn't have a task to make it.`);
					})
				);
			}
		}

		//resolve all the build/check tasks before returning:
		await Promise.all(pending);
	}

	//'job' says the contained function is an async job that should count against the JOBS limit:
	// returns a promise that resolves to the result of jobFn() (or rejects if jobFn() throws)
	// will always wait until at least the next tick to run jobFn()
	function job(jobFn) {
		//keep list of active and pending jobs:
		if (!('active' in job)) job.active = 0;
		if (!('pending' in job)) job.pending = [];

		//helper that runs a job on the pending queue:
		async function schedule() {
			if (job.active < JOBS && job.pending.length) {
				job.active += 1;
				//DEBUG: console.log(`[${job.active}/${JOBS} active, ${job.pending.length} pending]`);
				const next = job.pending.shift();
				try {
					next.resolve(await next.jobFn());
				} catch (e) {
					next.reject(e);
				}
				job.active -= 1;
				process.nextTick(schedule);
			}
		}

		//make sure to check for executable jobs next tick:
		process.nextTick(schedule);

		//throw job onto pending queue:
		return new Promise((resolve, reject) => {
			job.pending.push({jobFn, resolve, reject});
		});
	}

	//runCommand runs a command:
	async function runCommand(command, message) {
		await job(async () => {
			if (typeof message !== 'undefined') {
				console.log(message);
			}

			//print a command in a way that can be copied to a shell to run:
			let prettyCommand = '';
			for (const token of command) {
				if (prettyCommand !== '') prettyCommand += ' ';
				if (/[ \t\n!"'$&()*,;<>?[\\\]^`{|}~]/.test(token)
				 || token[0] === '='
				 || token[0] === '#') {
					//special characters => need to quote:
					prettyCommand += "'" + token.replace(/'/g, "'\\''") + "'";
				} else {
					prettyCommand += token;
				}
			}
			console.log('   ' + prettyCommand);

			//actually run the command:
			const child_process = require('child_process');

			//package as a promise and await it finishing:
			await new Promise((resolve, reject) => {
				const proc = child_process.spawn(command[0], command.slice(1), {
					shell:false,
					stdio:['ignore', 'inherit', 'inherit']
				});
				proc.on('exit', (code, signal) => {
					if (code !== 0) {
						reject(new BuildError(`command exited with code ${code}.\n  ${prettyCommand}`));
					} else {
						resolve();
					}
				});
				proc.on('error', (err) => {
					reject(new BuildError(`command error (${err.message}).\n  ${prettyCommand}`));
				});
			});
		});
	}

	//assertNontargets makes sure none of the mentioned prerequisites are targets of tasks:
	function assertNontargets(prerequisites, ruleName) {
		let errorFiles = [];
		for (const target of prerequisites) {
			if ('target' in maek.tasks) {
				errorFiles.push(target);
			}
		}
		if (errorFiles.length) {
			throw new BuildError(`the following *generated* files are required but not mentioned as dependancies:\n  ${errorFiles.join('\n  ')}`);
		}
	}

	//return a ['file:base64hash', 'file2:whateverHash', 'file3:etcstuff'] array,
	// representing the contents of a list of targets (with ':abstract' targets removed)
	async function hashFiles(targets) {
		const fs = require('fs');
		const crypto = require('crypto');

		const files = targets.filter(target => target[0] !== ':');

		//helper that will hash a single file: (non-existent files get special hash 'x')
		async function hashFile(file) {
			if (file in hashCache) {
				hashCacheHits += 1;
				return hashCache[file];
			}

			//would likely be more efficient to use a pipe with large files,
			//but this code is a bit more readable:
			const hash = await new Promise((resolve, reject) => {
				fs.readFile(file, (err, data) => {
					if (err) {
						//if failed to read file, report hash as 'x':
						resolve(`${file}:x`);
					} else {
						//otherwise, report base64-encoded md5sum of file data:
						const hash = crypto.createHash('md5');
						hash.update(data);
						resolve(`${file}:${hash.digest('base64')}`);
					}
				});
			});

			hashCache[file] = hash;
			return hash;
		}

		//get all hashes:
		return await Promise.all(files.map(hashFile));
	}

	//---------------------------------
	//Public Interface:

	maek.update = async (targets) => {
		console.log(`Maek v0.0 on ${OS} with ${JOBS} max jobs updating '${targets.join("', '")}'...`);

		//clean up any stale cachedKey values:
		for (const target of Object.keys(maek.tasks)) {
			delete maek.tasks[target].cachedKey;
		}
		//load cachedKey values from cache file:
		try {
			const cache = JSON.parse(fs.readFileSync(CACHE_FILE, {encoding:'utf8'}));
			let assigned = 0;
			let removed = 0;
			for (const target of Object.keys(cache)) {
				if (target in maek.tasks) {
					maek.tasks[target].cachedKey = cache[target];
					assigned += 1;
				} else {
					removed += 1;
				}
			}
			console.log(`   Loaded cache from '${CACHE_FILE}'; assigned ${assigned} targets and removed ${removed} stale entries.`);
		} catch (e) {
			console.log(`   No cache loaded; starting fresh.`);
			if (e.code !== 'ENOENT') {
				console.warn(`By the way, the reason the loading failed was the following unexpected error:`,e);
			}
		}

		//actually do the build:
		try {
			await updateTargets(targets, 'user');
		} catch (e) {
			if (e instanceof BuildError) {
				console.error(`FAILED: ${e.message}`);
				process.exit(1);
			} else {
				throw e;
			}
		}

		//store cachedKey values:
		const cache = {};
		let stored = 0;
		for (const target of Object.keys(maek.tasks)) {
			if ('cachedKey' in maek.tasks[target]) {
				cache[target] = maek.tasks[target].cachedKey;
				stored += 1;
			}
		}
		console.log(`Writing cache with ${stored} entries to '${CACHE_FILE}'...`);
		fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), {encoding:'utf8'});

		console.log(`hashCache ended up with ${Object.keys(hashCache).length} items and handled ${hashCacheHits} hits.`);

	};

	return maek;
}
