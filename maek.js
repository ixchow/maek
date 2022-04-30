
//make it so that all paths/commands are relative to this file's directory:
// (regardless of where you run it from)
process.chdir(__dirname);

//'make_build' is defined below so that all the rules end up here at the top:
// (it's a quirk of javascript that function definitions anywhere in scope get 'hoisted')
const build = make_build();

//call rules on the build object to specify tasks.
// rules generally look like:
//  output = build.RULE(input [, output_name] [, {options}])

//the 'CPP' rule returns the name of the object file:
const Player_obj = build.CPP('Player.cpp');
const Level_obj = build.CPP('Level.cpp');
const game_obj = build.CPP('game.cpp');
const test_obj = build.CPP('test.cpp');

//the 'LINK' rule returns the name of the executable file:
const game_exe = build.LINK([game_obj, Player_obj, Level_obj], 'dist/game');
const test_exe = build.LINK([test_obj, Player_obj, Level_obj], 'test/game-test');

//the 'RULE' rule is in Makefile-style 'targets', 'prerequisites', 'recipe' format:
build.RULE([':test'], [test_exe], [
	[test_exe, '--all-tests']
]);

// - - - - - - - - - - - - - -
//This code decides what targets to actually build:

//by default, build the ':dist' abstract target:
let targets = [':dist'];

//but if anything is on the command line, build that instead:
if (process.argv.length > 2) {
	targets = process.argv.slice(2);
}

//note: this is an async function...
build.update(targets);
//...which means it's not actually done here.
// (but node will wait until the function is done to exit)

//--------------------------------------------------------
//Now, onward to the code that makes all this work:

//First, the actual build object:
function make_build() {
	const os = require('os');
	const path = require('path').posix; //NOTE: expect posix-style paths even on windows
	const fsPromises = require('fs/promises');
	const fs = require('fs');

	//will fill in properties on this object with the public interface
	// to the build system and then return it:
	const build = {};

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

	//-----------------------------------------
	//Data:

	//build.tasks is a map from targets => tasks (possibly many-to-one):
	// a task is an async function that will make that target
	// (it will generally 'await' other tasks in the process)
	//
	// if task.keyFn is defined, it is used for caching (see build.cache, below).
	// generally keyFn will return an array of the content hashes of all input and output files,
	// along with version information and parameters for external commands called by the script.
	build.tasks = {};

	//during the build process some additional properties will be set on tasks:
	// task.cachedKey is used for caching:
	//  - after a task is run, the result of its keyFn is stored in cachedKey
	//  - a task will skipped if the result of its keyFn matches the result already in cachedKey
	//  comparisons are performed using: JSON.stringify(await task.keyFn()) === JSON.stringify(task.cachedKey)
	//
	// task.cachedKey values are loaded into the build.tasks array from CACHE_FILE at the start of build.update,
	// and stored into CACHE_FILE at the end of build.update.
	//
	// task.pending is set by updateTargets() to keep track of currently-running task updates.

	//-----------------------------------------
	//Build rules add tasks to build.tasks:

	//build.RULE adds a generic makefile-like task:
	// targets (array) are the things that get made
	// prerequisites (array) are the things that must be up-to-date before the recipe is run
	// recipe (array) is a list of commands
	build.RULE = (targets, prerequisites, recipe) => {
		if (!Array.isArray(targets)) throw new Error("build.RULE: targets must be an array.");
		if (!Array.isArray(prerequisites)) throw new Error("build.RULE: prerequisites must be an array.");
		if (!Array.isArray(recipe)) throw new Error("build.RULE: recipe must be an array.");

		const task = async () => {
			await updateTargets(prerequisites);
			for (const command of recipe) {
				await runCommand(command, `RULE: run '${command.join(' ')}'`);
			}
		};
		task.keyFn = async () => {
			await updateTargets(prerequisites); //prerequisites need to be ready before they can be hashed!
			return [
				...recipe,
				...(await hashFiles([...targets, ...prerequisites]))
			];
		};

		for (const target of targets) {
			build.tasks[target] = task;
		}
	};


	//build.CPP makes an object from a c++ source file:
	// cppFile is the source file name
	// objFile (optional) is the output file name

	build.CPP = (cppFile, objFile, {dir='objs'}={}) => {
		console.error(`TODO: write build.CPP for ${OS}.`);
		process.exit(1);
	};

	//build.LINK links an executable file from a collection of object files:
	// objFiles is an array of object file names
	// exeFile is the base name of the executable file ('.exe' will be added on windows)
	build.LINK = (objFiles, exeFile) => {
		console.error(`TODO: write build.LINK for ${OS}.`);
		process.exit(1);
	};

	if        (OS === 'windows') {
		//TODO
	} else if (OS === 'macos') {
		//TODO
	} else if (OS === 'linux') {
		build.CPP = (cppFile, objFile, {dir='objs'}={}) => {
			//if objFile name isn't given, compute from cppFile name and dir:
			if (typeof objFile === 'undefined') {
				objFile = path.relative('', dir + '/' + path.dirname(cppFile) + '/' + path.basename(cppFile,'.cpp') + '.o');
			}
			//computed dependencies go in a '.d' file stored next to the '.obj' file:
			const depsFile = objFile.replace(/\.o$/,'.d');

			//initial dependencies will just be the .cpp file:
			const depends = [cppFile];

			const cc = ['g++', '-std=c++20', '-Wall', '-Werror', '-g'];
			const depsCommand = [...cc, '-E', '-M', '-MG', '-MT', 'x ', '-MF', depsFile, cppFile];
			const objCommand = [...cc, '-c', '-o', objFile, cppFile];

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
					if (text[i] === '\t' || text[i] === ' ' || text[i] === '\n') {
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

				return tokens.slice(2);
			}

			//The actual build task:
			const task = async () => {
				//first, wait for any explicit prerequisites to build:
				await updateTargets(depends);
				//make object file:
				await fsPromises.mkdir(path.dirname(objFile), {recursive:true});
				await runCommand(objCommand, `CPP: compile '${cppFile}' -> '${objFile}'`);
				//make dependencies file: (NOTE: could do with same compile line)
				await fsPromises.mkdir(path.dirname(depsFile), {recursive:true});
				await runCommand(depsCommand,`CPP: prerequisites for '${cppFile}' -> '${depsFile}'`);
				//read extra dependencies and make sure they aren't targets of other rules:
				const extraDepends = await loadDeps();
				assertNontargets(extraDepends, `CPP: '${cppFile}' -> '${objFile}'`);
				//NOTE: if dynamic prerequisites are targets of other tasks there is a
				// problem whereby Maek can't know proper rule sequencing until it
				// has already run a rule.
			};

			task.keyFn = async () => {
				await updateTargets(depends);
				const extraDepends = await loadDeps();
				assertNontargets(extraDepends, `CPP: '${cppFile}' -> '${objFile}'`);
				return [
					objCommand,
					depsCommand,
					...(await hashFiles([objFile, depsFile, ...depends, ...extraDepends]))
				];
			};

			build.tasks[objFile] = task;

			return objFile;
		};

		build.LINK = (objFiles, exeFile) => {

			const link = ['g++', '-std=c++20', '-Wall', '-Werror', '-g'];
			const linkCommand = [...link, '-o', exeFile, ...objFiles];

			const depends = [...objFiles];

			const task = async () => {
				//first, wait for all requested object files to build:
				await updateTargets(depends);

				//then link:
				await fsPromises.mkdir(path.dirname(exeFile), {recursive:true});
				await runCommand(linkCommand, `LINK: link -> '${exeFile}'`);
			};

			task.keyFn = async () => {
				await updateTargets(depends);
				return [
					linkCommand,
					...(await hashFiles([exeFile, ...depends]))
				];
			};

			build.tasks[exeFile] = task;

			return exeFile;
		};
	}

	//---------------------------------
	//helper functions used by the build rules:

	//updateTargets takes a list of targets and updates them as needed.
	async function updateTargets(targets) {
		const fs = require('fs');
		const fsPromises = require('fs/promises');

		const pending = [];
		for (const target of targets) {
			//if target has an associated task, wait on that task:
			if (target in build.tasks) {
				const task = build.tasks[target];
				// launch task if not already pending:
				if (!('pending' in task)) {
					task.pending = (async () => {
						//check for cache hit:
						if ('cachedKey' in task) {
							if ('keyFn' in task) {
								const key = await task.keyFn();
								if (JSON.stringify(key) === JSON.stringify(task.cachedKey)) {
									//TODO: would be nice to have a task name here
									console.log(`SKIPPED: cache hit`);
									return;
								}
							}
						}
						//on cache miss, run task:
						await task();
						//and update cache:
						if ('keyFn' in task) {
							task.cachedKey = await task.keyFn();
						}
					})();
				}
				pending.push(task.pending);
			//otherwise, if target is abstract, complain because it isn't known:
			} else if (target[0] === ':') {
				console.error(`Target '${target}' is abstract but doesn't have a task.`);
				process.exit(1);
			//otherwise, target is a file, so check that it exists:
			} else {
				pending.push(
					fsPromises.access(target, fs.constants.R_OK).catch((e) => {
						console.error(`Target '${target}' doesn't exist and doesn't have a task to make it.`);
						process.exit(1);
					})
				);
			}
		}

		//resolve all the build/check tasks before returning:
		await Promise.all(pending);
	}

	//runCommand runs a command:
	async function runCommand(command, message) {
		if (typeof message !== 'undefined') {
			console.log(message);
		}

		//print a command in a way that can be copied to a shell to run:
		const prettyCommand = [];
		for (const token of command) {
			if (/[ \t\n!"'$&()*,;<>?[\\\]^`{|}~]/.test(token)
			 || token[0] === '='
			 || token[0] === '#') {
				//special characters => need to quote:
				prettyCommand.push("'" + token.replace(/'/g, "'\\''") + "'");
			} else {
				prettyCommand.push(token);
			}
		}
		console.log('   ' + prettyCommand.join(' '));

		//actually run the command:
		const child_process = require('child_process');

		//package as a promise and await it finishing:
		let code = await new Promise((resolve, reject) => {
			const proc = child_process.spawn(command[0], command.slice(1), {
				shell:false,
				stdio:['ignore', 'inherit', 'inherit']
			});
			proc.on('close', resolve);
			proc.on('error', reject);
		});

		if (code !== 0) {
			console.error(`!!! Command exited with code ${code}`);
			process.exit(1);
		}
	}

	//assertNontargets makes sure none of the mentioned prerequisites are targets of tasks:
	function assertNontargets(prerequisites, ruleName) {
		let errorFiles = [];
		for (const target of prerequisites) {
			if ('target' in build.tasks) {
				errorFiles.push(target);
			}
		}
		if (errorFiles.length) {
			console.error(`${ruleName} ERROR: the following *generated* files are required but not mentioned as dependancies:\n   ${errorFiles.join('\n   ')}`);
			process.exit(1);
		}
	}

	//return a ['file:base64hash', 'file2:whateverHash', 'file3:etcstuff'] array,
	// representing the contents of a list of files.
	async function hashFiles(files) {
		const fs = require('fs');
		const crypto = require('crypto');

		//helper that will hash a single file: (non-existent files get special hash 'x')
		function hashFile(file) {
			//TODO: consider a hash cache!

			//would likely be more efficient to use a pipe with large files,
			//but this code is a bit more readable:
			return new Promise((resolve, reject) => {
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
		}

		//get all hashes:
		return await Promise.all(files.map(hashFile));
	}

	//---------------------------------
	//Public Interface:

	build.update = async (targets) => {
		console.log(`Maek v0.0 on ${OS} updating '${targets.join("', '")}'...`);

		//clean up any stale cachedKey values:
		for (const target of Object.keys(build.tasks)) {
			delete build.tasks[target].cachedKey;
		}
		//load cachedKey values from cache file:
		try {
			const cache = JSON.parse(fs.readFileSync(CACHE_FILE, {encoding:'utf8'}));
			let assigned = 0;
			let removed = 0;
			for (const target of Object.keys(cache)) {
				if (target in build.tasks) {
					build.tasks[target].cachedKey = cache[target];
					assigned += 1;
				} else {
					removed += 1;
				}
			}
			console.log(` Loaded cache from '${CACHE_FILE}'; assigned ${assigned} targets and removed ${removed} stale entries.`);
		} catch (e) {
			build.cache = {};
			console.log(` No cache loaded; starting fresh.`);
			if (e.code !== 'ENOENT') {
				console.warn(`By the way, the reason the loading failed was the following unexpected error:`,e);
			}
		}

		//actually do the build:
		await updateTargets(targets);

		//store cachedKey values:
		const cache = {};
		let stored = 0;
		for (const target of Object.keys(build.tasks)) {
			if ('cachedKey' in build.tasks[target]) {
				cache[target] = build.tasks[target].cachedKey;
				stored += 1;
			}
		}
		console.log(`Writing cache with ${stored} entries to '${CACHE_FILE}'...`);
		await fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), {encoding:'utf8'});

	};

	return build;
}
