
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

console.log(`Building '${targets.join("', '")}'...`);
updateTargets(targets);

//--------------------------------------------------------
//Now, onward to the code that makes all this work:

//First, the actual build object:
function make_build() {
	const os = require('os');
	const path = require('path').posix; //NOTE: expect posix-style paths even on windows
	const fsPromises = require('fs/promises');

	//will fill in properties on this object then return it:
	const build = {};

	//build.os is the current OS:
	// (with slightly nicer naming than os.platform()
	switch (os.platform()) {
		case 'win32': build.os = 'windows';
			break;
		case 'darwin':
			build.os = 'macos';
			break;
		case 'linux':
			build.os = 'linux';
			break;
		default:
			console.error(`ERROR: Unrecognized platform ${os.platform()}.`);
			process.exit(1);
	}

	//build.targets is a map from targets => tasks (possibly many-to-one):
	// a task is an async function that will make that target
	// (it may wait on other tasks in the process)
	build.targets = {}

	//build.RULE is a generic makefile-like rule:
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
		for (const target of targets) {
			build.targets[target] = task;
		}
	};


	//build.CPP makes an object from a c++ source file:
	// cppFile is the source file name
	// objFile (optional) is the output file name

	build.CPP = (cppFile, objFile, {dir='objs/'}) => {
		console.error(`TODO: write build.CPP for ${build.os}.`);
		process.exit(1);
	};

	//build.LINK links an executable file from a collection of object files:
	// objFiles is an array of object file names
	// exeFile is the base name of the executable file ('.exe' will be added on windows)
	build.LINK = (objFiles, exeFile) => {
		console.error(`TODO: write build.LINK for ${build.os}.`);
		process.exit(1);
	};


	if        (build.os === 'windows') {
		//TODO
	} else if (build.os === 'macos') {
		//TODO
	} else if (build.os === 'linux') {
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
			const depsCommand = [...cc, '-E', '-MD', '-o', depsFile, cppFile];
			const objCommand = [...cc, '-c', '-o', objFile, cppFile];

			//The actual build task:
			build.targets[objFile] = async () => {
				//first, wait for any explicit prerequisites to build:
				await updateTargets(depends);

				//then, compute implicit prerequisites:
				await fsPromises.mkdir(path.dirname(depsFile), {recursive:true});
				await runCommand(depsCommand, `CPP: prerequisites for '${cppFile}' -> '${depsFile}'`);

				//load the computed prerequisites:
				let deps = await fsPromises.readFile(depsFile, {encoding:'utf8'});

				const implicitDepends = [];
				//(TODO: split deps into target names to make implicitDepends...)

				//wait for implicit prerequisites to build:
				await updateTargets(implicitDepends);

				//finally, actually build:
				await fsPromises.mkdir(path.dirname(objFile), {recursive:true});
				await runCommand(objCommand, `CPP: compile '${cppFile}' -> '${objFile}'`);
			};

			return objFile;
		};

		build.LINK = (objFiles, exeFile) => {

			const link = ['g++', '-std=c++20', '-Wall', '-Werror', '-g'];
			const linkCommand = [...link, '-o', exeFile, ...objFiles];

			const depends = [...objFiles];

			build.targets[exeFile] = async () => {
				//first, wait for all requested object files to build:
				await updateTargets(depends);

				//then link:
				await fsPromises.mkdir(path.dirname(exeFile), {recursive:true});
				await runCommand(linkCommand, `LINK: link -> '${exeFile}'`);
			};

			return exeFile;
		};
	}

	return build;
}

//-------------------------------------------------
//helper functions used by the various build rules:

async function updateTargets(targets) {
	const fs = require('fs');
	const fsPromises = require('fs/promises');

	const pending = [];
	for (const target of targets) {
		//if target has an associated task, wait on that task:
		if (target in build.targets) {
			const task = build.targets[target];
			// launch task if not already pending:
			if (!('pending' in task)) {
				task.pending = task();
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

async function runCommand(command, message) {
	if (typeof message !== 'undefined') {
		console.log(message);
	}

	//print the command nicely:
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
