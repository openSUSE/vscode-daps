// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below


const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const xpath = require('xpath');
const { DOMParser } = require('xmldom');
var terminal = vscode.window.createTerminal('DAPS');
const execSync = require('child_process').execSync;
const workspaceFolderUri = vscode.workspace.workspaceFolders[0].uri;
const buildTargets = ['pdf', 'html'];

/**
 * class that creates data for DOcBook structure TreeView
 */
class docStructureTreeDataProvider {
	constructor() {
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
	}

	refresh() {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element) {
		return element;
	}

	getChildren(element) {
		// get XML file content
		const filePath = getActiveFile();
		var docContent = fs.readFileSync(filePath, 'utf-8');
		console.log(`length of docContent: ${docContent.length}`);
		// configure parser
		//xpath.useNamespaces({ db: 'http://docbook.org/ns/docbook' });
		const parser = new DOMParser({ errorHandler: { warning: null }, locator: {} }, { ignoreUndefinedEntities: true });
		const xmlDoc = parser.parseFromString(docContent, 'text/xml');
		const sectionElements = xmlDoc.getElementsByTagName('section');
		for (let i = 0; i < sectionElements.length; i++) {
			const sectionElement = sectionElements[i];
			console.dir(sectionElement);
			console.log(`parent node: ${sectionElement.parentNode.nodeName}_${sectionElement.parentNode.lineNumber}`);
			console.log(`section name: ${sectionElement.getElementsByTagName('title')[0].textContent}`)
				;		}

		/* console.log(`xpathQuery result length: ${result.length}`);
		for (let i = 0; i < result.length; i++) {
			sections.push({
				label: result[i].data,
				collapsibleState: vscode.TreeItemCollapsibleState.None,
				id: result[i].data
			});
		}

		return sections; */
	}
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	console.log('Congratulations, your extension "daps" is now active!');
	var extensionPath = context.extensionPath;
	console.log(`Extension path: ${extensionPath}`);

	/**
	 * create treeview for DocBook structure
	 */
	const treeDataProvider = new docStructureTreeDataProvider;
	context.subscriptions.push(vscode.window.registerTreeDataProvider('docbookFileStructure', treeDataProvider))
	vscode.commands.registerCommand('docStructureTreeView.refresh', () => {
		treeDataProvider.refresh();
	})
	/**
	 * command for opening editor, optionally in a split window
	 */
	context.subscriptions.push(vscode.commands.registerCommand('daps.openFile', async (file) => {
		const dapsConfig = vscode.workspace.getConfiguration('daps');
		const viewColumn = vscode.ViewColumn.Beside;
		try {
			if (dapsConfig.get('openFileSplit')) {
				await vscode.workspace.openTextDocument(file).then((document) => {
					vscode.window.showTextDocument(document, { viewColumn });
				});
			} else {
				await vscode.workspace.openTextDocument(file).then((document) => {
					vscode.window.showTextDocument(document, { undefined });
				});
			}
		} catch (err) {
			vscode.window.showErrorMessage(`Error opening file: ${err.message}`);
		}
	}));
	/**
	 * enable codelens for DocBook assembly files
	 */
	context.subscriptions.push(vscode.languages.registerCodeLensProvider({ pattern: '**/*.asm.xml' }, {
		provideCodeLenses(document) {
			const codeLenses = [];
			const pattern = /resourceref=["'](.+)["']/;
			for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
				const line = document.lineAt(lineNumber);
				const matches = line.text.match(pattern);
				if (matches) {
					const capturedID = matches[1];
					// in this file, find a file name corresponding to the matched XML ID
					const docText = document.getText();
					const filePattern = new RegExp(`resource xml:id=["']${capturedID}["'] href=["'](.+)["']`, "g");
					// Create a CodeLens for each match
					const range = new vscode.Range(lineNumber, 0, lineNumber, line.text.length);
					let fileMatches;
					let hrefValue;
					while ((fileMatches = filePattern.exec(docText))) {
						hrefValue = fileMatches[1];
						const activeEditorPath = vscode.window.activeTextEditor.document.uri.fsPath
						const directoryPath = activeEditorPath.substring(0, activeEditorPath.lastIndexOf('/'));
						const codeLens = new vscode.CodeLens(range, {
							title: `Points to a file "${path.basename(hrefValue)}"`,
							command: 'daps.openFile',
							arguments: [`${directoryPath}/${hrefValue}`]
						});
						codeLenses.push(codeLens);
					}
				}
			}
			return codeLenses;
		}
	}));

	/**
	 * enable autocomplete XML entities from external files
	 */
	const dapsConfig = vscode.workspace.getConfiguration('daps');
	if (dapsConfig.get('autocompleteXMLentities')) {
		context.subscriptions.push(vscode.languages.registerCompletionItemProvider('xml', {
			provideCompletionItems(document, position, token, context) {
				console.log(`doc: ${document.fileName}, pos: ${position.line}, token: ${token.isCancellationRequested}, context: ${context.triggerKind}`);
				// get array of entity files
				let entityFiles = getXMLentityFiles(document.fileName);
				//extract entites from entity files
				let entities = getXMLentites(entityFiles);
				let result = [];
				entities.forEach(entity => {
					let completionItem = new vscode.CompletionItem(entity);
					completionItem.label = `&${entity}`;
					completionItem.kind = vscode.CompletionItemKind.Keyword;
					completionItem.filterText = entity.substring(-1);
					// dont double && when triggered with &
					if (context.triggerKind == 0) {
						completionItem.insertText = new vscode.SnippetString(`&${entity}`);
					} else {
						completionItem.insertText = new vscode.SnippetString(entity);
					}
					result.push(completionItem);
				});
				return result;
			}
		}, '&'));
	}

	/**
	 * enables document HTML preview + handler to update it when src doc chanegs
	 */
	let previewPanel = undefined;
	context.subscriptions.push(vscode.commands.registerCommand('daps.docPreview', function docPreview(contextFileURI) {
		// get img src path from config
		const dapsConfig = vscode.workspace.getConfiguration('daps');
		// path to images
		let docPreviewImgPath = dapsConfig.get('docPreviewImgPath');
		// create a new webView if it does not exist yet
		if (previewPanel === undefined) {
			previewPanel = vscode.window.createWebviewPanel(
				'htmlPreview', // Identifies the type of the webview
				'HTML Preview', // Title displayed in the panel
				vscode.ViewColumn.Two, // Editor column to show the webview panel
				{}
			);
		}
		// what is the document i want to preview?
		let srcXMLfile = getActiveFile(contextFileURI);
		console.log(`Source XML file: ${srcXMLfile}`);
		// compile transform command
		let transformCmd = `xsltproc --stringparam img.src.path ${docPreviewImgPath} ${extensionPath}/xslt/doc-preview.xsl ${srcXMLfile}`;
		console.log(`xsltproc cmd: ${transformCmd}`);
		// get its stdout into a variable
		let htmlContent = execSync(transformCmd).toString();
		// resolve the file's directory and cd there
		previewPanel.webview.html = htmlContent;
		previewPanel.onDidDispose(() => {
			// The panel has been disposed of, so reset the global reference
			previewPanel = undefined;
		});
	}));
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
		console.log(`onChange document: ${document.uri.path}`);
		if (document.uri.path == getActiveFile() && previewPanel) {
			vscode.commands.executeCommand('daps.docPreview');
		}
	}));


	/**
	 * @description validates documentation identified by DC file
	 * @param {string} DCfile URI from context command (optional)
	 * @returns true or false depending on how validation happened
	 */
	let disposeValidate = vscode.commands.registerCommand('daps.validate', async function validate(contextDCfile) {
		var DCfile = await getDCfile(contextDCfile);
		if (DCfile) {
			// assemble daps command
			const dapsCmd = getDapsCmd({ DCfile: DCfile, cmd: 'validate' });
			const dapsConfig = vscode.workspace.getConfiguration('daps');
			// change working directory to current workspace
			process.chdir(workspaceFolderUri.path);
			console.log(`cwd is ${workspaceFolderUri.path}`);
			// decide whether to run terminal
			try {
				if (dapsConfig.get('runTerminal')) {
					console.log('Running command in terminal');
					terminal.sendText(dapsCmd);
					terminal.show(true);
				} else {
					vscode.window.showInformationMessage(`Running ${dapsCmd}`);
					execSync(dapsCmd);
					vscode.window.showInformationMessage('Validation succeeded.');
				}
				return true;
			} catch (err) {
				vscode.window.showErrorMessage(`Validation failed: ${err}`);
			}
		}
		return false;
	});
	/**
	 * @description builds HTML or PDF targets given DC file
	 * @param {object} DCfile URI from context command (optional)
	 * @returns true or false depending on how the build happened
	 */
	let disposeBuildDC = vscode.commands.registerCommand('daps.buildDCfile', async function buildDCfile(contextDCfile) {
		var buildTarget;
		var DCfile = await getDCfile(contextDCfile);
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
			var params = {
				DCfile: DCfile,
				buildTarget: buildTarget,
			}
			var dapsCmd = getDapsCmd(params);
			const dapsConfig = vscode.workspace.getConfiguration('daps');
			try {
				// change working directory to current workspace
				process.chdir(workspaceFolderUri.path);
				console.log(`cwd is ${workspaceFolderUri.path}`);
				if (dapsConfig.get('runTerminal')) {
					console.log('Running command in terminal');
					terminal.sendText(dapsCmd);
					terminal.show(true);
				} else {
					vscode.window.showInformationMessage(`Running ${dapsCmd}`);
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
				}
				return true;
			} catch (err) {
				vscode.window.showErrorMessage(`Build failed: ${err}.message`);
			}
		}
		return false;
	});

	/**
	 * command to build single XML file
	 */
	let disposeBuildXMLfile = vscode.commands.registerCommand('daps.buildXMLfile', async function buildXMLfile(contextFileURI) {
		// decide on input XML file - take active editor if file not specified from context
		var XMLfile = getActiveFile(contextFileURI);
		var buildTarget = await getBuildTarget();
		if (buildTarget) {
			var params = {
				XMLfile: XMLfile,
				buildTarget: buildTarget,
				options: ['--norefcheck']
			}
			// add --single option for HTML builds
			if (buildTarget == 'html') {
				params['options'].push('--single');
			}
			var dapsCmd = getDapsCmd(params);
			const dapsConfig = vscode.workspace.getConfiguration('daps');
			try {
				await autoSave(XMLfile);
				if (dapsConfig.get('runTerminal')) {
					console.log('Running command in terminal');
					terminal.sendText(dapsCmd);
					terminal.show(true);
				} else {
					vscode.window.showInformationMessage(`Running ${dapsCmd}`);
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
				}
				return true;
			} catch (err) {
				vscode.window.showErrorMessage(`Build failed: ${err.message}`);
			}
		}
	});
	let disposeBuildRootId = vscode.commands.registerCommand('daps.buildRootId', async function buildRootId(contextFileURI) {
		var buildTarget = await getBuildTarget();
		var DCfile = await getDCfile();
		var rootId = await getRootId(contextFileURI, DCfile);
		// assemble daps command
		if (DCfile && rootId && buildTarget) {
			const params = {
				DCfile: DCfile,
				buildTarget: buildTarget,
				rootId: rootId
			}
			const dapsCmd = getDapsCmd(params);
			const dapsConfig = vscode.workspace.getConfiguration('daps');
			try {
				// change working directory to current workspace
				process.chdir(workspaceFolderUri.path);
				console.log(`cwd is ${workspaceFolderUri.path}`);
				if (dapsConfig.get('runTerminal')) {
					console.log('Running command in terminal');
					terminal.sendText(dapsCmd);
					terminal.show(true);
				} else {
					vscode.window.showInformationMessage(`Running ${dapsCmd}`);
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
				}
				return true;
			} catch (err) {
				vscode.window.showErrorMessage(`Build failed: ${err.message}`);
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
			// vscode.window.showInformationMessage(`XMLformatting ${XMLfile}`);
			await autoSave(XMLfile);
			const dapsXMLformatCmd = `daps-xmlformat -i ${XMLfile}`;
			console.log(`XML format cmd: ${dapsXMLformatCmd}`);
			execSync(dapsXMLformatCmd);
			// vscode.window.showInformationMessage(`XMLformat succeeded. ${XMLfile}`);
			return true;
		} catch (err) {
			vscode.window.showErrorMessage(`XMLformat failed: ${err.message}`);
			return false;
		}
	});
	context.subscriptions.push(disposeValidate, disposeBuildDC, disposeBuildRootId, disposeXMLformat, disposeBuildXMLfile);
	/**
	 * @description assembles daps command based on given parameters
	 * @param {Array} given parameters
	 * @returns {String} daps command that can be executed
	 */
	function getDapsCmd(params) {
		// get daps configuration hash
		const dapsConfig = vscode.workspace.getConfiguration('daps');
		var dapsCmd = [];
		dapsCmd.push(dapsConfig.get('dapsExecutable'));
		if (dapsConfig.get('dapsRoot')) {
			dapsCmd.push('--dapsroot ' + dapsConfig.get('dapsRoot'));
		}
		if (dapsConfig.get('verbosityLevel') && dapsConfig.get('runTerminal')) {
			dapsCmd.push('-v' + dapsConfig.get('verbosityLevel'));
		}
		if (dapsConfig.get('styleRoot') && params['cmd'] != 'validate') {
			dapsCmd.push('--styleroot ' + dapsConfig.get('styleRoot'));
		}
		if (params['DCfile']) {
			dapsCmd.push('-d ' + params['DCfile']);
		} else if (params['XMLfile']) {
			dapsCmd.push('-m ' + params['XMLfile']);
		}
		if (params['cmd']) {
			dapsCmd.push(params['cmd']);
		} else if (params['buildTarget']) {
			dapsCmd.push(params['buildTarget']);
		}
		if (params['rootId']) {
			dapsCmd.push('--rootid ' + params['rootId']);
		}
		if (params['options']) {
			dapsCmd.push(params['options'].join(' '));
		}
		console.log(`dapsCmd: ${dapsCmd.join(' ')}`);
		return dapsCmd.join(' ');
	}

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
						vscode.window.showErrorMessage(err.message);
						return false;
					}
				}
			}
		}
	}
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

function getXMLentityFiles(XMLfile) {
	// decide where getentityname.py is located
	const dapsConfig = vscode.workspace.getConfiguration('daps');
	var getEntScript = null;
	if (dapsConfig.get('dapsRoot')) {
		getEntScript = `${dapsConfig.get('dapsRoot')}/libexec/getentityname.py`;
	} else {
		getEntScript = '/usr/share/daps/libexec/getentityname.py';
	}
	console.log(`get-ent script: ${getEntScript}`);
	var getEntFilesCmd = `${getEntScript} ${XMLfile}`;
	console.log(`get-ent cmd: ${getEntFilesCmd}`);
	var result = execSync(getEntFilesCmd).toString().trim().split(' ');
	console.log(`num of entity files: ${result.length}`);
	// exclude entities included in 'excludeXMLentityFiles' option
	var excludedEntityFiles = dapsConfig.get('excludeXMLentityFiles');
	if (excludedEntityFiles) {
		for (var i = 0; i < result.length; i++) {
			for (var j = 0; j < excludedEntityFiles.length; j++) {
				if (result[i].endsWith(excludedEntityFiles[j])) {
					console.log(`excluding ent file: ${excludedEntityFiles[j]}`)
					result.splice(i, 1);
					break;
				}
			}
		}
	}
	console.log(`entity files: ${result}`);
	return result;
}

function getXMLentites(entityFiles) {
	// extract XML entities from files to a list
	var entList = [];
	entityFiles.forEach(entFile => {
		entList = entList.concat(fs.readFileSync(entFile, 'utf8').split('\n').filter(line => {
			// return line.startsWith('<!ENTITY');
			return line.match(/^<!ENTITY [^%]/);
		}));
	});
	console.log(`size of entList: ${entList.length}`);
	// leave only entity names in the entity array

	var result = entList.map(processEntLine);
	function processEntLine(line) {
		return `${line.split(" ")[1]};`;
	}
	return result;
}

/**
	 * @description Resolves active file name from either context argument or active editor
	 * @param {URI} contextFileURI 
	 * @returns {string} Path to the active file
	 */
function getActiveFile(contextFileURI) {
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
	return XMLfile;
}

// Function to get line numbers of nodes and their parent node
function getLineNumbersAndParent(node) {
	const startLine = node.startContainer.lineNumber - 1; // Line numbers start at 1
	const endLine = node.endContainer.lineNumber - 1;

	const lineNumbers = [];
	for (let i = startLine; i <= endLine; i++) {
		lineNumbers.push(i + 1); // Add 1 to convert back to 1-based line numbers
	}

	// Get parent node information
	const parent = node.parentNode;
	const parentName = parent.nodeName;

	return {
		lineNumbers,
		parentName,
	};
}

// This method is called when your extension is deactivated
function deactivate() { }

module.exports = {
	activate,
	deactivate
}

