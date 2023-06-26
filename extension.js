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

	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "daps" is now active!');

	// The commandId parameter must match the command field in package.json
	let disposable1 = vscode.commands.registerCommand('daps.validate.DCfile', () => validateDCfile());

	let disposable2 = vscode.commands.registerCommand('daps.build', function () {
		// change working directory to current workspace
		try {
			process.chdir(workspaceFolderUri.path);
			console.log('cwd is ' + workspaceFolderUri.path);
		} catch (err) {
			console.error('cwd: ' + err);
		}
		// get DC files from user
		let DCfiles = getDCfiles();
		// select DC file
		vscode.window.showQuickPick(DCfiles).then((DCfile) => {
			// select build target
			vscode.window.showQuickPick(buildTargets).then((buildTarget) => {
				// assemble daps command
				const dapsCmd = 'daps -d ' + DCfile + ' ' + buildTarget;
				try {
					vscode.window.showInformationMessage('Running ' + dapsCmd);
					let cmdOutput = execSync(dapsCmd);
					let targetBuild = cmdOutput.toString();
					if (buildTarget == 'html') {
						targetBuild = targetBuild.trim() + 'index.html';
					}
					console.log('target build: ' + targetBuild);
					vscode.window.showInformationMessage('Build succeeded.', 'Open document').then(selected => {
						console.log(selected);
						if (selected === 'Open document') {
							exec('xdg-open ' + targetBuild);
						}
					});
				} catch (err) {
					vscode.window.showErrorMessage('Build failed: ' + err);
				}
			});

		})
	});

	context.subscriptions.push(disposable1, disposable2);
}

async function validateDCfile() {
	var DCfile;
	const dapsConfig = vscode.workspace.getConfiguration('daps');
	// change working directory to current workspace
	try {
		process.chdir(workspaceFolderUri.path);
		console.log('cwd is ' + workspaceFolderUri.path);
	} catch (err) {
		console.error('cwd: ' + err);
	}
	// try if DC file is included in settings
	if (DCfile = dapsConfig.get('setDCfile')) {
		console.log('DC file from config: ' + DCfile);
	} else {
		DCfile = await vscode.window.showQuickPick(getDCfiles());
		console.log('DC file form picker: ' + DCfile);
	}
	// assemble daps command
	if (DCfile) {
		const dapsCmd = 'daps -d ' + DCfile + ' validate';
		try {
			vscode.window.showInformationMessage('Running ' + dapsCmd);
			execSync(dapsCmd);
			vscode.window.showInformationMessage('Validation succeeded.');
		} catch (err) {
			vscode.window.showErrorMessage('Validation failed: ' + err);
		}
	}
}

function getDCfiles() {
	// get list of DC files in the workspace
	console.log(workspaceFolderUri.path);
	const items = fs.readdirSync(workspaceFolderUri.path).filter(it => it.startsWith('DC-'));
	return items;
}
// This method is called when your extension is deactivated
function deactivate() { }

module.exports = {
	activate,
	deactivate
}
