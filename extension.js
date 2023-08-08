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
	var extensionPath = context.extensionPath;
	console.log(`Extension path: ${extensionPath}`)
	let disposeValidate = vscode.commands.registerCommand('daps.validate', (DCfile) => validate(DCfile));
	let disposeBuildDC = vscode.commands.registerCommand('daps.buildDCfile', (DCfile) => buildDCfile(DCfile));
	let disposeBuildXMLfile = vscode.commands.registerCommand('daps.buildXMLfile', async function buildXMLfile(contextFileURI) {
		// decide on input XML file - take active editor if file not specified from context
		var XMLfile;
		if (contextFileURI) {
			XMLfile = contextFileURI.path
			console.log(`XML file from context: ${XMLfile}`);
		} else if (vscode.window.activeTextEditor) {
			XMLfile = vscode.window.activeTextEditor.document.fileName
			console.log(`XML file from active editor: ${XMLfile}`);
		} else {
			console.error('No active nor contextual XML file specified');
			return false;
		}
		var buildTarget = await getBuildTarget();
		if (buildTarget) {
			var dapsCmd = `daps -m ${XMLfile} ${buildTarget} --norefcheck`;
			// add --single option for HTML builds
			if (buildTarget == 'html') {
				console.log('Adding --single option for HTML target');
				dapsCmd += ' --single';
			}
			try {
				vscode.window.showInformationMessage(`Running ${dapsCmd}`);
				await autoSave(XMLfile);
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
				vscode.window.showErrorMessage(`Build failed: ${err}`);
			}
		}
	});
	let disposeBuildRootId = vscode.commands.registerCommand('daps.buildRootId', async function buildRootId(contextFileURI) {
		var buildTarget = await getBuildTarget();
		var DCfile = await getDCfile();
		var rootId = await getRootId(contextFileURI, DCfile);
		// assemble daps command
		if (DCfile && rootId && buildTarget) {
			var dapsCmd = `daps -d ${DCfile} ${buildTarget} --rootid ${rootId}`;
			try {
				vscode.window.showInformationMessage('Running ' + dapsCmd);
				// change working directory to current workspace
				process.chdir(workspaceFolderUri.path);
				console.log(`cwd is ${workspaceFolderUri.path}`);
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
				vscode.window.showErrorMessage(`Build failed: ${err}`);
			}
		}
		return false;
	});
	let disposeXMLformat = vscode.commands.registerCommand('daps.XMLformat', async function XMLformat(contextFileURI) {
		var XMLfile;
		if (contextFileURI) { //check if XML file was passed as context
			XMLfile = contextFileURI.path;
			console.log(`XMLfile from context: ${XMLfile}`);
		} else if (vscode.window.activeTextEditor) { // try the currently open file
			XMLfile = vscode.window.activeTextEditor.document.fileName;
			console.log(`XML file from active editor: ${XMLfile}`);
		} else {
			console.error('No XML file specified or active');
			return false;
		}

		try {
			vscode.window.showInformationMessage(`XMLformatting ${XMLfile}`);
			await autoSave(XMLfile);
			execSync(`daps-xmlformat -i ${XMLfile}`);
			vscode.window.showInformationMessage(`XMLformat succeeded. ${XMLfile}`);
			return true;
		} catch (err) {
			vscode.window.showErrorMessage(`XMLformat failed: ${err}`);
			return false;
		}
	});
	context.subscriptions.push(disposeValidate, disposeBuildDC, disposeBuildRootId, disposeXMLformat, disposeBuildXMLfile);

	/**
	 * @description resolves root ID from context, config, or user input
	 * @param {string} contextFileURI optional from context
	 * @param {string} DCfile DC file to get the target root ID from
	 * @returns {string} discovered root ID
	 */
	async function getRootId(contextFileURI, DCfile) {
		var rootId;
		const dapsConfig = vscode.workspace.getConfiguration('daps');
		if (contextFileURI) { // check if rootId was passed as argument
			const editor = vscode.window.activeTextEditor;
			const selection = editor.selection;
			if (selection && !selection.isEmpty) {
				const selectionRange = new vscode.Range(selection.start.line, selection.start.character, selection.end.line, selection.end.character);
				rootId = editor.document.getText(selectionRange);
			}
			console.log(`rootId from context: ${rootId}`);
		} else if (rootId = dapsConfig.get('buildRootId')) { // try if rootId is included in settings.json
			console.log(`rootId from config: ${rootId}`);
		} else { // get rootId from picker
			rootId = await vscode.window.showQuickPick(getRootIds(DCfile));
			console.log(`rootId form picker: ${rootId}`);
		}
		return rootId;
	}
	function getRootIds(DCfile) {
		process.chdir(workspaceFolderUri.path);
		console.log(`cwd is ${workspaceFolderUri.path}`);
		var rootIdsCmd = `sh -c "cat \`daps -d ${DCfile} bigfile | tail -n1\` | xsltproc ${extensionPath}/xslt/get-ids-from-structure.xsl - | cut -d# -f2"`;
		console.log(`root IDs cmd: ${rootIdsCmd}`);
		var rootIds = execSync(rootIdsCmd).toString().trim().split('\n');
		console.log(`Count of root IDs: ${rootIds.length}`);
		return rootIds;
	}
	/**
	 * @description checks if given path represents a textDocument and saves it if dirty
	 * @param {string} XMLfile - path to file on filesystem
	 * @returns {boolean}
	 */
	async function autoSave(XMLfile) {
		const dapsConfig = vscode.workspace.getConfiguration('daps');
		if (dapsConfig.get('autoSave') == true) {
			//var document = vscode.Uri.parse(XMLfile);
			const textDocuments = vscode.workspace.textDocuments;
			console.log(`Number of text documents: ${textDocuments.length}`);
			for (let i = 0; i < textDocuments.length; i++) {
				if (XMLfile == textDocuments[i].fileName && textDocuments[i].isDirty) {
					try {
						await textDocuments[i].save();
						console.log(`document ${XMLfile} saved`);
						return true;
					} catch (err) {
						vscode.window.showErrorMessage(err);
						return false;
					}
				}
			}
		}
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
			const dapsCmd = `daps -d ${DCfile} validate`;
			try {
				vscode.window.showInformationMessage(`Running ${dapsCmd}`);
				// change working directory to current workspace
				process.chdir(workspaceFolderUri.path);
				console.log(`cwd is ${workspaceFolderUri.path}`);
				execSync(dapsCmd);
				vscode.window.showInformationMessage('Validation succeeded.');
				return true;
			} catch (err) {
				vscode.window.showErrorMessage(`Validation failed: ${err}`);
			}
		}
		return false;
	}
}



/**
 * @description builds HTML or PDF targets given DC file
 * @param {obj} DCfile URI from context command (optional)
 * @returns true or false depending on how the build happened
 */
async function buildDCfile() {
	var buildTarget;
	var DCfile = await getDCfile(arguments[0]);
	// try if buildTarget is included in settings or get it from user
	const dapsConfig = vscode.workspace.getConfiguration('daps');
	if (buildTarget = dapsConfig.get('buildTarget')) {
		console.log(`buildTarget from config: ${buildTarget}`);
	} else {
		buildTarget = await vscode.window.showQuickPick(buildTargets);
		console.log(`buildTarget form picker: ${buildTarget}`);
	}

	// assemble daps command
	if (DCfile && buildTarget) {
		var dapsCmd = `daps -d ${DCfile} ${buildTarget}`;
		try {
			vscode.window.showInformationMessage(`Running ${dapsCmd}`);
			// change working directory to current workspace
			process.chdir(workspaceFolderUri.path);
			console.log(`cwd is ${workspaceFolderUri.path}`);
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
			vscode.window.showErrorMessage(`Build failed: ${err}`);
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
	console.log(`folder: ${folderUri.path}`);
	var allFiles = fs.readdirSync(folderUri.path);
	console.log(`no of all files: ${allFiles.length}`)
	var DCfiles = allFiles.filter(it => it.startsWith('DC-'));
	console.log(`no of DC files: ${DCfiles.length}`);
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
		// if yes, use only the base name from the full URI
		DCfile = DCfile.path.split('/').pop();
		console.log(`DCfile from context: ${DCfile}`);
	} else if (DCfile = dapsConfig.get('DCfile')) { // try if DC file is included in settings.json
		console.log(`DC file from config: ${DCfile}`);
	} else { // get DC file from picker
		DCfile = await vscode.window.showQuickPick(getDCfiles(workspaceFolderUri));
		console.log(`DC file form picker: ${DCfile}`);
	}
	return DCfile;
}

/**
 * @description decides on build target, config or manually entered
 * @param null
 * @returns {string} build target
 */
async function getBuildTarget() {
	// try if buildTarget is included in settings or get it from user
	const dapsConfig = vscode.workspace.getConfiguration('daps');
	var buildTarget;
	if (buildTarget = dapsConfig.get('buildTarget')) {
		console.log(`buildTarget from config: ${buildTarget}`);
	} else {
		buildTarget = await vscode.window.showQuickPick(buildTargets);
		console.log(`buildTarget form picker: ${buildTarget}`);
	}
	return buildTarget;
}


// This method is called when your extension is deactivated
function deactivate() { }

module.exports = {
	activate,
	deactivate
}
