const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
// configure parser
const { DOMParser } = require('@xmldom/xmldom');
//const { match } = require('assert');
const parser = new DOMParser({ errorHandler: { warning: null }, locator: {} }, { ignoreUndefinedEntities: true });
const execSync = require('child_process').execSync;
const workspaceFolderUri = vscode.workspace.workspaceFolders[0].uri;
const buildTargets = ['pdf', 'html'];
const dapsConfigGlobal = vscode.workspace.getConfiguration('daps');
const dbgChannel = vscode.window.createOutputChannel('DAPS');

// create or re-use DAPS terminal
var terminal = null;
for (let i = 0; i < vscode.window.terminals.length; i++) {
	if (vscode.window.terminals[i].name == 'DAPS') {
		terminal = vscode.window.terminals[i];
		break;
	}
}
if (terminal == null) {
	terminal = vscode.window.createTerminal('DAPS');
}

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
		if (!filePath) {
			return emptyDocStructure('No DocBook XML editor opened');
		}
		var docContent = fs.readFileSync(filePath, 'utf-8');
		const xmlDoc = parser.parseFromString(docContent, 'text/xml');
		const dapsConfig = vscode.workspace.getConfiguration('daps');
		const structureElements = dapsConfig.get('structureElements');
		var sectionElements = getElementsWithAllowedTagNames(xmlDoc, structureElements);
		dbg(`sectionElements length: ${sectionElements.length}`);
		if (sectionElements.length == 0) {
			return emptyDocStructure('The current document has no structure')
		}
		var result = [];
		for (let i = 0; i < sectionElements.length; i++) {
			const sectionElement = sectionElements[i];
			// if no treeview item was clicked and the iterated sectionElement's parent is not structural
			if (((!element && !structureElements.includes(sectionElement.parentNode.nodeName)))
				// or treeview item is clicked and the iterated sectionElement is a kid of the clicked item
				|| (element && (`${sectionElement.parentNode.nodeName}_${sectionElement.parentNode.lineNumber}` == element.id))) {
				// does element have 'section' kids?
				var collapsibleState;
				for (let j = 0; j < sectionElement.childNodes.length; j++) {
					if (structureElements.includes(sectionElement.childNodes[j].nodeName)) {
						collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
						break;
					} else {
						collapsibleState = vscode.TreeItemCollapsibleState.None;
					}
				}
				// does the element have a title?
				var label = null;
				if (sectionElement.getElementsByTagName('title')[0]) {
					label = `(${sectionElement.nodeName.substring(0, 1)}) "${sectionElement.getElementsByTagName('title')[0].textContent}"`;
				} else {
					label = `(${sectionElement.nodeName.substring(0, 1)}) "*** MISSING TITLE ***"`;
				}
				result.push({
					label: label,
					// iconPath: vscode.ThemeIcon.Folder,
					collapsibleState: collapsibleState,
					id: `${sectionElement.nodeName}_${sectionElement.lineNumber}`,
					parentId: `${sectionElement.parentNode.nodeName}_${sectionElement.parentNode.lineNumber}`,
					command: {
						title: 'Activate related line',
						command: 'daps.focusLineInActiveEditor',
						arguments: [sectionElement.lineNumber.toString()]
					}
				});
			}
		}
		return result;
	}
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	dbg('Congratulations, your extension "daps" is now active!');
	dbg('Debug channel opened');
	var extensionPath = context.extensionPath;
	dbg(`Extension path: ${extensionPath}`);
	// cmd for focusing a line in active editor
	vscode.commands.registerCommand('daps.focusLineInActiveEditor', async (lineNumber) => {
		const activeTextEditor = vscode.window.activeTextEditor;
		if (activeTextEditor) {
			const dapsConfig = vscode.workspace.getConfiguration('daps');

			if (dapsConfig.get('onClickedStructureItemMoveCursor')) {
				// Ensure the lineNumber is within valid bounds
				lineNumber = Math.max(0, Math.min(lineNumber, activeTextEditor.document.lineCount - 1));
				// Create a Position object for the desired line
				const position = new vscode.Position(lineNumber, 0);
				// Move the cursor to the specified position
				activeTextEditor.selection = new vscode.Selection(position, position);
				// Reveal the position in the active editor
				activeTextEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
				// Create a Uri for the active document
				const documentUri = activeTextEditor.document.uri;
				// Show the document and move the cursor to the specified position
				await vscode.window.showTextDocument(documentUri, {
					selection: new vscode.Range(lineNumber, 0, lineNumber, 0),
					viewColumn: activeTextEditor.viewColumn
				});
			} else {
				// Create a Range object for the desired line
				const lineRange = activeTextEditor.document.lineAt(lineNumber - 1).range;
				// Reveal the line in the editor
				activeTextEditor.revealRange(lineRange, vscode.TextEditorRevealType.InCenter);
			}

		}
	});
	// register the peek definition command
	context.subscriptions.push(vscode.commands.registerCommand('daps.peekFile', async (filePath, range) => {
		const uri = vscode.Uri.file(filePath);
		vscode.commands.executeCommand('editor.action.peekLocations', uri, range.start, [new vscode.Location(uri, range)], 'peek');
	}));
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
	vscode.commands.registerCommand('daps.openFile', async (file, line) => {
		const dapsConfig = vscode.workspace.getConfiguration('daps');
		const viewMode = dapsConfig.get('openFileSplit') ? vscode.ViewColumn.Beside : { preview: false };

		try {
			const document = await vscode.workspace.openTextDocument(file);
			const editor = vscode.window.showTextDocument(document, viewMode);
			// Ensure the line number is valid
			const lineNumber = Math.max(0, Math.min(line, document.lineCount - 1));
			// Reveal the line in the editor
			const position = new vscode.Position(lineNumber, 0);
			const range = new vscode.Range(position, position);
			(await editor).revealRange(range, vscode.TextEditorRevealType.AtTop);
			editor.selection = new vscode.Selection(position, position);
		} catch (err) {
			vscode.window.showErrorMessage(`Error opening file: ${err.message}`);
		}
	});
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((activeEditor) => {
		if (activeEditor && activeEditor.document.languageId === 'xml') {
			vscode.commands.executeCommand('docStructureTreeView.refresh');
		}
	}));
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => {
		vscode.commands.executeCommand('docStructureTreeView.refresh');
	}));
	/**
	 * enable codelens for DocBook assembly files
	 */
	context.subscriptions.push(vscode.languages.registerCodeLensProvider({ pattern: dapsConfigGlobal.get('dbAssemblyPattern') }, {
		provideCodeLenses(document) {
			// parse active editor's XML
			const xmlDoc = parser.parseFromString(document.getText());
			// get all <resource/> object
			const resourceElements = xmlDoc.getElementsByTagName('resource');
			// find 'xml:id' and 'href' attributes to each of them and store in hash
			const resources = {};
			for (let i = 0; i < resourceElements.length; i++) {
				const resource = resourceElements[i];
				const xmlId = resource.getAttribute('xml:id');
				const href = resource.getAttribute('href');
				resources[xmlId] = href;
			}
			// get all <module/> objects
			const moduleElements = xmlDoc.getElementsByTagName('module');
			dbg(`moduleElements length: ${moduleElements.length}`);
			// collect their attributes and push them to the result array
			const codeLenses = [];
			for (let i = 0; i < moduleElements.length; i++) {
				const module = moduleElements[i];
				const lineNumber = module.lineNumber - 1;
				dbg(`codelenses - lineNumber: ${lineNumber}`);
				const resourceRef = module.getAttribute('resourceref');
				dbg(`codelenses - resourceRef: ${resourceRef}`);
				const activeRange = new vscode.Range(lineNumber, 0, lineNumber, 0);
				const activeEditorPath = vscode.window.activeTextEditor.document.uri.fsPath
				const directoryPath = activeEditorPath.substring(0, activeEditorPath.lastIndexOf('/'));
				dbg(`codelenses - Path: ${directoryPath}/${resources[resourceRef]}`);
				if (resourceRef) {
					// create a codelens for opening the file as a peek
					const activeUri = vscode.window.activeTextEditor.document.uri;
					const peekRange = new vscode.Range(0, 0, 15, 0);
					const peekUri = vscode.Uri.file(`${directoryPath}/${resources[resourceRef]}`);
					const peekLocation = new vscode.Location(peekUri, peekRange);
					dbg(`codelens:uri: ${activeUri}`);
					const codeLensPeek = new vscode.CodeLens(activeRange, {
						title: `Peek into ${path.basename(resources[resourceRef])} `,
						command: "editor.action.peekLocations",
						arguments: [activeUri, activeRange.start, [peekLocation]]
					});
					codeLenses.push(codeLensPeek);
					// create codelens for opening the file in a tab
					const codeLensOpen = new vscode.CodeLens(activeRange, {
						title: "Open in a new tab",
						command: 'daps.openFile',
						arguments: [`${directoryPath}/${resources[resourceRef]}`]
					});
					codeLenses.push(codeLensOpen);

				}
			}
			return codeLenses;
		}
	}));
	/**
	 * provide codelens for <xref/>'s targets
	 */
	context.subscriptions.push(vscode.languages.registerCodeLensProvider({ pattern: "**/*.xml" }, {
		provideCodeLenses(document) {
			// parse active editor's XML
			const xmlDoc = parser.parseFromString(document.getText());
			// get all <xref/> objects
			const xrefElements = xmlDoc.getElementsByTagName('xref');
			dbg(`codelens:xref:xrefElements.length: ${xrefElements.length}`);
			// iterate over discovered xrefs and find their xml:id's definition in all *.xml files
			const codeLenses = [];
			for (let i = 0; i < xrefElements.length; i++) {
				const xrefLinkend = xrefElements[i].getAttribute('linkend');
				dbg(`codelens:xref:xrefLinkend: ${xrefLinkend}`);
				// search for all files that reference the xrefLinkends
				dbg(workspaceFolderUri.fsPath);
				const matchedReferers = searchInFiles(workspaceFolderUri.fsPath, `xml:id="${xrefLinkend}"`, /\.xml$/);
				dbg(`codelens:xref:matchedReferers: ${matchedReferers.length}`);
				const lineNumber = xrefElements[i].lineNumber - 1;
				dbg(`codelens:xref:lineNumber: ${lineNumber}`);
				const columnNumber = xrefElements[i].columnNumber;
				dbg(`codelens:xref:columnNumber: ${columnNumber}`);
				const activeRange = new vscode.Range(lineNumber, columnNumber, lineNumber, columnNumber);
				// iterate over corresponding xml:id's definitions and create codelense
				for (let j = 0; j < matchedReferers.length; j++) {
					dbg(`codelens:xref:matchedReferer ${j}: ${matchedReferers[j].file}`);
					// create a codelens for opening the file as a peek
					const activeUri = vscode.window.activeTextEditor.document.uri;
					dbg(`codelens:xref:peekLine: ${matchedReferers[j].line}`);
					dbg(`codelens:xref:peekColumn: ${matchedReferers[j].column}`);
					const peekRange = new vscode.Range(
						new vscode.Position(matchedReferers[j].line, 0),
						new vscode.Position(matchedReferers[j].line + 15, 0)
					);
					const peekUri = vscode.Uri.file(matchedReferers[j].file);
					dbg(`codelens:xref:peekUri: ${peekUri}`);
					const peekLocation = new vscode.Location(peekUri, peekRange);
					dbg(`codelens:xref:peekLocation: ${peekLocation.uri}`);
					const codeLensPeek = new vscode.CodeLens(activeRange, {
						title: `Peek into ${path.basename(matchedReferers[j].file)} `,
						command: "editor.action.peekLocations",
						arguments: [activeUri, activeRange.start, [peekLocation]]
					});
					codeLenses.push(codeLensPeek);
					// create codelens for opening the file in a tab
					const codeLensOpen = new vscode.CodeLens(activeRange, {
						title: "Open in a new tab",
						command: 'daps.openFile',
						arguments: [`${matchedReferers[j].file}`, matchedReferers[j].line]
					});
					codeLenses.push(codeLensOpen);
					dbg(`codelens:xref:codeLenses.length: ${codeLenses.length}`);


				}
			}
			return codeLenses;
		}
	}));
	/**
	* Search for a specific string in files matching a pattern within a directory.
	* @param {string} dir - The directory to search within.
	* @param {string} searchTerm - The string to search for.
	* @param {RegExp} filePattern - The pattern to match files.
	* @returns {Array} - An array of search results.
	*/
	function searchInFiles(dir, searchTerm, filePattern) {
		let results = [];
		const files = fs.readdirSync(dir);

		files.forEach(file => {
			const filePath = path.join(dir, file);
			const stats = fs.statSync(filePath);

			if (stats.isDirectory()) {
				// Skip directories that begin with a period
				if (path.basename(filePath).startsWith('.')) {
					return;
				}
				// Recursive call for subdirectories
				results = results.concat(searchInFiles(filePath, searchTerm, filePattern));
			} else if (filePattern.test(filePath)) {
				const content = fs.readFileSync(filePath, 'utf8');
				const lines = content.split('\n');
				lines.forEach((line, lineNumber) => {
					let columnNumber = line.indexOf(searchTerm);
					while (columnNumber !== -1) {
						results.push({
							file: filePath,
							line: lineNumber,
							column: columnNumber,
							match: line.trim()
						});
						columnNumber = line.indexOf(searchTerm, columnNumber + 1);
					}
				});
			}
		});
		return results;
	}
	/**
	 * enable autocomplete XML entities from external files
	 */
	const dapsConfig = vscode.workspace.getConfiguration('daps');
	if (dapsConfig.get('autocompleteXMLentities')) {
		dbg(`autocompleteXMLentities: ${dapsConfig.get('autocompleteXMLentities')}`)
		context.subscriptions.push(vscode.languages.registerCompletionItemProvider('xml', {
			provideCompletionItems(document, position, token, context) {
				dbg(`doc: ${document.fileName}, pos: ${position.line}, token: ${token.isCancellationRequested}, context: ${context.triggerKind}`);
				dbg(`doc: ${document.fileName}, pos: ${position.line}, token: ${token.isCancellationRequested}, context: ${context.triggerKind}`);
				// get array of entity files
				let entityFiles = getXMLentityFiles(document.fileName);
				dbg(`Number of entity files: ${entityFiles.length}`);
				//extract entites from entity files
				let entities = getXMLentites(entityFiles);
				dbg(`Number of entities: ${entities.length}`);
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
				dbg(`Number of results: ${result.length}`);
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
		dbg(`Source XML file: ${srcXMLfile}`);
		// compile transform command
		let transformCmd = `xsltproc --stringparam img.src.path ${docPreviewImgPath} ${extensionPath}/xslt/doc-preview.xsl ${srcXMLfile}`;
		dbg(`xsltproc cmd: ${transformCmd}`);
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
		dbg(`onChange document: ${document.uri.path}`);
		if (document.uri.path == getActiveFile() && previewPanel) {
			vscode.commands.executeCommand('daps.docPreview');
		}
	}));


	/**
	 * @description validates documentation identified by DC file
	 * @param {string} DCfile URI from context command (optional)
	 * @returns true or false depending on how validation happened
	 */
	context.subscriptions.push(vscode.commands.registerCommand('daps.validate', async function validate(contextDCfile) {
		var DCfile = await getDCfile(contextDCfile);
		if (DCfile) {
			// assemble daps command
			const dapsCmd = getDapsCmd({ DCfile: DCfile, cmd: 'validate' });
			const dapsConfig = vscode.workspace.getConfiguration('daps');
			// change working directory to current workspace
			process.chdir(workspaceFolderUri.path);
			dbg(`cwd is ${workspaceFolderUri.path}`);
			// decide whether to run terminal
			try {
				if (dapsConfig.get('runTerminal')) {
					dbg('Running command in terminal');
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
	}));
	/**
	 * @description builds HTML or PDF targets given DC file
	 * @param {object} DCfile URI from context command (optional)
	 * @returns true or false depending on how the build happened
	 */
	context.subscriptions.push(vscode.commands.registerCommand('daps.buildDCfile', async function buildDCfile(contextDCfile) {
		var buildTarget;
		var DCfile = await getDCfile(contextDCfile);
		// try if buildTarget is included in settings or get it from user
		const dapsConfig = vscode.workspace.getConfiguration('daps');
		if (buildTarget = dapsConfig.get('buildTarget')) {
			dbg(`buildTarget from config: ${buildTarget}`);
		} else {
			buildTarget = await vscode.window.showQuickPick(buildTargets);
			dbg(`buildTarget form picker: ${buildTarget}`);
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
				dbg(`cwd is ${workspaceFolderUri.path}`);
				if (dapsConfig.get('runTerminal')) {
					dbg('Running command in terminal');
					terminal.sendText(dapsCmd);
					terminal.show(true);
				} else {
					vscode.window.showInformationMessage(`Running ${dapsCmd}`);
					let cmdOutput = execSync(dapsCmd);
					let targetBuild = cmdOutput.toString().trim();
					if (buildTarget == 'html') {
						targetBuild = targetBuild + 'index.html';
					}
					dbg('target build: ' + targetBuild);
					vscode.window.showInformationMessage('Build succeeded.', 'Open document', 'Copy link').then(selected => {
						dbg(selected);
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
	}));

	/**
	 * command to build single XML file
	 */
	context.subscriptions.push(vscode.commands.registerCommand('daps.buildXMLfile', async function buildXMLfile(contextFileURI) {
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
					dbg('Running command in terminal');
					terminal.sendText(dapsCmd);
					terminal.show(true);
				} else {
					vscode.window.showInformationMessage(`Running ${dapsCmd}`);
					let cmdOutput = execSync(dapsCmd);
					let targetBuild = cmdOutput.toString().trim();
					if (buildTarget == 'html') {
						targetBuild = targetBuild + 'index.html';
					}
					dbg('target build: ' + targetBuild);
					vscode.window.showInformationMessage('Build succeeded.', 'Open document', 'Copy link').then(selected => {
						dbg(selected);
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
	}));
	context.subscriptions.push(vscode.commands.registerCommand('daps.buildRootId', async function buildRootId(contextFileURI) {
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
				dbg(`cwd is ${workspaceFolderUri.path}`);
				if (dapsConfig.get('runTerminal')) {
					dbg('Running command in terminal');
					terminal.sendText(dapsCmd);
					terminal.show(true);
				} else {
					vscode.window.showInformationMessage(`Running ${dapsCmd}`);
					let cmdOutput = execSync(dapsCmd);
					let targetBuild = cmdOutput.toString().trim();
					if (buildTarget == 'html') {
						targetBuild = targetBuild + 'index.html';
					}
					dbg('target build: ' + targetBuild);
					vscode.window.showInformationMessage('Build succeeded.', 'Open document', 'Copy link').then(selected => {
						dbg(selected);
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
	}));
	context.subscriptions.push(vscode.commands.registerCommand('daps.XMLformat', async function XMLformat(contextFileURI) {
		var XMLfile;
		if (contextFileURI) { //check if XML file was passed as context
			XMLfile = contextFileURI.path;
			dbg(`XMLfile from context: ${XMLfile}`);
		} else if (vscode.window.activeTextEditor) { // try the currently open file
			XMLfile = vscode.window.activeTextEditor.document.fileName;
			dbg(`XML file from active editor: ${XMLfile}`);
		} else {
			console.error('No XML file specified or active');
			return false;
		}

		try {
			var dapsXMLformatCmd = null;
			// vscode.window.showInformationMessage(`XMLformatting ${XMLfile}`);
			await autoSave(XMLfile);
			const dapsConfig = vscode.workspace.getConfiguration('daps');
			dapsXMLformatCmd = `${dapsConfig.get('XMLformatExecutable')} -i ${XMLfile}`;
			if (dapsConfig.get('XMLformatConfigFile')) {
				dapsXMLformatCmd += ` -f ${dapsConfig.get('XMLformatConfigFile')}`
			}
			dbg(`XML format cmd: ${dapsXMLformatCmd}`);
			execSync(dapsXMLformatCmd);
			// vscode.window.showInformationMessage(`XMLformat succeeded. ${XMLfile}`);
			return true;
		} catch (err) {
			vscode.window.showErrorMessage(`XMLformat failed: ${err.message}`);
			return false;
		}
	}));

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
		if (dapsConfig.get('styleRoot')) {
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
		dbg(`dapsCmd: ${dapsCmd.join(' ')}`);
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
			dbg(`rootId from context: ${rootId}`);
		} else if (rootId = dapsConfig.get('buildRootId')) { // try if rootId is included in settings.json
			dbg(`rootId from config: ${rootId}`);
		} else { // get rootId from picker
			rootId = await vscode.window.showQuickPick(getRootIds(DCfile));
			dbg(`rootId form picker: ${rootId}`);
		}
		return rootId;
	}
	function getRootIds(DCfile) {
		process.chdir(workspaceFolderUri.path);
		dbg(`cwd is ${workspaceFolderUri.path}`);
		var rootIdsCmd = `sh -c "cat \`daps -d ${DCfile} bigfile | tail -n1\` | xsltproc ${extensionPath}/xslt/get-ids-from-structure.xsl - | cut -d# -f2"`;
		dbg(`root IDs cmd: ${rootIdsCmd}`);
		var rootIds = execSync(rootIdsCmd).toString().trim().split('\n');
		dbg(`Count of root IDs: ${rootIds.length}`);
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
			dbg(`Number of text documents: ${textDocuments.length}`);
			for (let i = 0; i < textDocuments.length; i++) {
				if (XMLfile == textDocuments[i].fileName && textDocuments[i].isDirty) {
					try {
						await textDocuments[i].save();
						dbg(`document ${XMLfile} saved`);
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

//debugging
function dbg(msg) {
	const dapsConfig = vscode.workspace.getConfiguration('daps');
	if (dapsConfig.get('enableDbg') == 'output') {
		dbgChannel.appendLine(`dbg: ${msg}`);
	} else if (dapsConfig.get('enableDbg') == 'console') {
		console.log(`dbg: ${msg}`);
	} else if (dapsConfig.get('enableDbg') == 'both') {
		dbgChannel.appendLine(`dbg: ${msg}`);
		console.log(`dbg: ${msg}`);
	}
}

/**
 * @description compiles list of DC files in gicen directory
 * @param {obj} URI of a folder to get DC files from
 * @returns {array} of DC files from the current directory
 */
function getDCfiles(folderUri) {
	dbg(`folder: ${folderUri.path}`);
	var allFiles = fs.readdirSync(folderUri.path);
	dbg(`no of all files: ${allFiles.length}`)
	var DCfiles = allFiles.filter(it => it.startsWith('DC-'));
	dbg(`no of DC files: ${DCfiles.length}`);
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
		dbg(`DCfile from context: ${DCfile}`);
	} else if (DCfile = dapsConfig.get('DCfile')) { // try if DC file is included in settings.json
		dbg(`DC file from config: ${DCfile}`);
	} else { // get DC file from picker
		DCfile = await vscode.window.showQuickPick(getDCfiles(workspaceFolderUri));
		dbg(`DC file form picker: ${DCfile}`);
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
		dbg(`buildTarget from config: ${buildTarget}`);
	} else {
		buildTarget = await vscode.window.showQuickPick(buildTargets);
		dbg(`buildTarget form picker: ${buildTarget}`);
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
	dbg(`get-ent script: ${getEntScript}`);
	var getEntFilesCmd = `${getEntScript} ${XMLfile}`;
	dbg(`get-ent cmd: ${getEntFilesCmd}`);
	var result = execSync(getEntFilesCmd).toString().trim().split(' ');
	dbg(`num of entity files: ${result.length}`);
	// exclude entities included in 'excludeXMLentityFiles' option
	var excludedEntityFiles = dapsConfig.get('excludeXMLentityFiles');
	if (excludedEntityFiles) {
		for (var i = 0; i < result.length; i++) {
			for (var j = 0; j < excludedEntityFiles.length; j++) {
				if (result[i].endsWith(excludedEntityFiles[j])) {
					dbg(`excluding ent file: ${excludedEntityFiles[j]}`)
					result.splice(i, 1);
					break;
				}
			}
		}
	}
	dbg(`entity files: ${result}`);
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
	dbg(`size of entList: ${entList.length}`);
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
		dbg(`XMLfile from context: ${XMLfile}`);
	} else if (vscode.window.activeTextEditor) { // try the currently open file
		XMLfile = vscode.window.activeTextEditor.document.fileName;
		dbg(`XML file from active editor: ${XMLfile}`);
	} else {
		console.error('No XML file specified or active');
		return false;
	}
	return XMLfile;
}

// returns empty TreeItem with a specific message
function emptyDocStructure(message) {
	return [{
		label: message,
		collapsibleState: vscode.TreeItemCollapsibleState.None,
	}]
}

// Function to get elements with tag names from the structureElements array
function getElementsWithAllowedTagNames(rootElement, allowedTagNames) {
	const result = [];

	// Get all elements in the document
	const allElements = rootElement.getElementsByTagName('*');

	for (let i = 0; i < allElements.length; i++) {
		const element = allElements[i];
		const tagName = element.tagName.toLowerCase();

		// Check if the tag name is in the allowedTagNames array
		if (allowedTagNames.includes(tagName)) {
			result.push(element);
		}
	}

	return result;
}

// This method is called when your extension is deactivated
function deactivate() { }

module.exports = {
	activate,
	deactivate
}

