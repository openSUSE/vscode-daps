// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const fs = require('fs');
const { exec } = require('child_process');
const execSync = require('child_process').execSync;
const workspaceFolderUri = vscode.workspace.workspaceFolders[0].uri;
const buildTargets = ['pdf', 'html'];

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {

	console.log('Congratulations, your extension "daps" is now active!');
	let disposable1 = vscode.commands.registerCommand('daps.validate', (DCfile) => validate(DCfile));
	let disposable2 = vscode.commands.registerCommand('daps.build', (DCfile) => buildTarget(DCfile));
	let disposable3 = vscode.commands.registerCommand('daps.XMLformat', () => XMLformat());
	context.subscriptions.push(disposable1, disposable2, disposable3);
}

function XMLformat() {
	var curFile = vscode.window.activeTextEditor.document.fileName;
	console.log('Current file to format: ' + curFile);
	try {
		execSync('daps-xmlformat -i ' + curFile);
	} catch (err) {
		console.error(err);
	}
}
/**
 * @description builds HTML or PDF targets given DC file
 * @param {obj} DCfile URI from context command (optional)
 * @returns true or false depending on how the build happened
 */
async function buildTarget() {
	var buildTarget;
	var DCfile = await getDCfile(arguments[0]);
	// try if buildTarget is included in settings or get it from user
	const dapsConfig = vscode.workspace.getConfiguration('daps');
	if (buildTarget = dapsConfig.get('buildTarget')) {
		console.log('buildTarget from config: ' + buildTarget);
	} else {
		buildTarget = await vscode.window.showQuickPick(buildTargets);
		console.log('buildTarget form picker: ' + buildTarget);
	}
	// assemble daps command
	const dapsCmd = 'daps -d ' + DCfile + ' ' + buildTarget;
	if (DCfile && buildTarget) {
		try {
			vscode.window.showInformationMessage('Running ' + dapsCmd);
			// change working directory to current workspace
			process.chdir(workspaceFolderUri.path);
			console.log('cwd is ' + workspaceFolderUri.path);
			let cmdOutput = execSync(dapsCmd);
			let targetBuild = cmdOutput.toString().trim();
			if (buildTarget == 'html') {
				targetBuild = targetBuild + 'index.html';
			}
			console.log('target build: ' + targetBuild);
			vscode.window.showInformationMessage('Build succeeded.', 'Open document', 'Copy link').then(selected => {
				console.log(selected);
				if (selected === 'Open document') {
					exec('xdg-open ' + targetBuild);
				} else if (selected === 'Copy link') {
					vscode.env.clipboard.writeText(targetBuild);
				}
			});
			return true;
		} catch (err) {
			vscode.window.showErrorMessage('Build failed: ' + err);
		}
	}
	return false;
}
/**
 * @description validates documentation identified by DC file
 * @param {obj} DCfile URI from context command (optional)
 * @returns true or false depending on how validation happened
 */
async function validate() {
	var DCfile = await getDCfile(arguments[0]);
	if (DCfile) {
		// assemble daps command
		const dapsCmd = 'daps -d ' + DCfile + ' validate';
		try {
			vscode.window.showInformationMessage('Running ' + dapsCmd);
			// change working directory to current workspace
			process.chdir(workspaceFolderUri.path);
			console.log('cwd is ' + workspaceFolderUri.path);
			execSync(dapsCmd);
			vscode.window.showInformationMessage('Validation succeeded.');
			return true;
		} catch (err) {
			vscode.window.showErrorMessage('Validation failed: ' + err);
		}
	}
	return false;
}

/**
 * @description compiles list of DC files in gicen directory
 * @param {obj} URI of a folder to get DC files from
 * @returns {array} of DC files from the current directory
 */
function getDCfiles(folderUri) {
	console.log('folder: ' + folderUri.path);
	var allFiles = fs.readdirSync(folderUri.path);
	console.log('no of all files: ' + allFiles.length)
	var DCfiles = allFiles.filter(it => it.startsWith('DC-'));
	console.log('no of DC files: ' + DCfiles.length);
	return DCfiles;
}
/**
 * @description picks DC file from various sources
 * @param {obj} DCfile URI from context command (optional)
 * @returns {string} DCfile name
 */
async function getDCfile() {
	var DCfile;
	const dapsConfig = vscode.workspace.getConfiguration('daps');
	if (DCfile = arguments[0]) { // check if DCfile URI was passed as argument
		// use only the base name from the full URI
		DCfile = DCfile.path.split('/').pop();
		console.log('DCfile from context: ' + DCfile);
	} else if (DCfile = dapsConfig.get('DCfile')) { // try if DC file is included in settings.json
		console.log('DC file from config: ' + DCfile);
	} else { // get DC file from picker
		DCfile = await vscode.window.showQuickPick(getDCfiles(workspaceFolderUri));
		console.log('DC file form picker: ' + DCfile);
	}
	return DCfile;
}
// This method is called when your extension is deactivated
function deactivate() { }

module.exports = {
	activate,
	deactivate
}
