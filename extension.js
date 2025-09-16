const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { DOMParser } = require('@xmldom/xmldom');
const parser = new DOMParser({ errorHandler: { warning: null }, locator: {} }, { ignoreUndefinedEntities: true });
const execSync = require('child_process').execSync;
const workspaceFolderUri = vscode.workspace.workspaceFolders[0].uri;
const buildTargets = ['html', 'pdf'];
const dapsConfigGlobal = vscode.workspace.getConfiguration('daps');
const dbgChannel = vscode.window.createOutputChannel('DAPS');
let previewPanel = undefined;


/**
 * Holds the DAPS terminal instance, or null if it hasn't been created yet.
 */
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
 * Provides the data for the DocBook structure tree view in the VS Code extension.
 * This class is responsible for managing the tree view, including refreshing the
 * view and providing the tree items.
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
		// Check if there are any open XML editors
		const hasOpenXmlEditor = vscode.window.visibleTextEditors.some(
			editor => editor.document.languageId === 'xml'
		);
		if (!hasOpenXmlEditor) {
			return this._createEmptyStructure('No DocBook XML editor opened');
		}

		const filePath = this._getActiveFile();
		if (!filePath) {
			return this._createEmptyStructure('No DocBook XML editor opened');
		}

		const xmlDoc = this._parseXmlDocument(filePath);
		const structureElements = this._getStructureElements();
		const sectionElements = getElementsWithAllowedTagNames(xmlDoc, structureElements);

		if (sectionElements.length === 0) {
			return this._createEmptyStructure('The current document has no structure');
		}

		return this._createTreeItems(element, sectionElements, structureElements);
	}

	_getActiveFile() {
		return getActiveFile();
	}

	_parseXmlDocument(filePath) {
		const docContent = fs.readFileSync(filePath, 'utf-8');
		return parser.parseFromString(docContent, 'text/xml');
	}

	_getStructureElements() {
		const dapsConfig = vscode.workspace.getConfiguration('daps');
		return dapsConfig.get('structureElements');
	}

	_createEmptyStructure(message) {
		return [{
			label: message,
			collapsibleState: vscode.TreeItemCollapsibleState.None,
		}];
	}

	_createTreeItems(element, sectionElements, structureElements) {
		return sectionElements
			.filter(sectionElement => this._shouldIncludeElement(element, sectionElement, structureElements))
			.map(sectionElement => this._createTreeItem(sectionElement, structureElements));
	}

	_shouldIncludeElement(element, sectionElement, structureElements) {
		return (!element && !structureElements.includes(sectionElement.parentNode.nodeName)) ||
			(element && `${sectionElement.parentNode.nodeName}_${sectionElement.parentNode.lineNumber}` === element.id);
	}

	_createTreeItem(sectionElement, structureElements) {
		const collapsibleState = this._determineCollapsibleState(sectionElement, structureElements);
		const label = this._createLabel(sectionElement);

		return {
			label,
			collapsibleState,
			id: `${sectionElement.nodeName}_${sectionElement.lineNumber}`,
			parentId: `${sectionElement.parentNode.nodeName}_${sectionElement.parentNode.lineNumber}`,
			command: {
				title: 'Activate related line',
				command: 'daps.focusLineInActiveEditor',
				arguments: [sectionElement.lineNumber.toString()]
			}
		};
	}

	_determineCollapsibleState(sectionElement, structureElements) {
		for (let i = 0; i < sectionElement.childNodes.length; i++) {
			if (structureElements.includes(sectionElement.childNodes[i].nodeName)) {
				return vscode.TreeItemCollapsibleState.Collapsed;
			}
		}
		return vscode.TreeItemCollapsibleState.None;
	}

	_createLabel(sectionElement) {
		const titleElement = sectionElement.getElementsByTagName('title')[0];
		const title = titleElement ? titleElement.textContent : '*** MISSING TITLE ***';
		return `(${sectionElement.nodeName.substring(0, 1)}) "${title}"`;
	}
}

/**
 * Provides CodeLens items for assembly modules in the current document.
 * This class listens for save events on the active document and refreshes the CodeLenses when the document is saved.
 * The CodeLenses provide actions to peek into the referenced resources and open them in a new tab.
 */
class assemblyModulesCodeLensesProvider {
	constructor() {
		this._cachedCodeLenses = new Map();
		this._onDidChangeCodeLensesEmitter = new vscode.EventEmitter();
		this.onDidChangeCodeLenses = this._onDidChangeCodeLensesEmitter.event;

		// Listen for save events to refresh the CodeLenses
		vscode.workspace.onDidSaveTextDocument((document) => {
			const pattern = dapsConfigGlobal.get('dbAssemblyPattern');
			if (vscode.languages.match({ pattern }, document)) {
				this.refresh(document);
			}
		});
	}

	provideCodeLenses(document) {
		// Return cached CodeLenses if available
		const cached = this._cachedCodeLenses.get(document.uri.toString());
		if (cached) {
			return cached;
		}

		// If no cache is available, return an empty array
		return [];
	}

	refresh(document) {
		// Recompute CodeLenses and cache them
		const codeLenses = this._computeCodeLenses(document);
		this._cachedCodeLenses.set(document.uri.toString(), codeLenses);

		// Notify VSCode to refresh CodeLenses
		this._onDidChangeCodeLensesEmitter.fire();
	}

	_computeCodeLenses(document) {
		const parser = new DOMParser(); // Assuming parser is declared elsewhere
		const xmlDoc = parser.parseFromString(document.getText());
		const resourceElements = xmlDoc.getElementsByTagName('resource');

		// Build resource id->href mapping
		const resources = {};
		for (let i = 0; i < resourceElements.length; i++) {
			const resource = resourceElements[i];
			resources[resource.getAttribute('xml:id')] = resource.getAttribute('href');
		}

		// Process modules and create CodeLens items
		const moduleElements = xmlDoc.getElementsByTagName('module');
		const codeLenses = [];

		for (let i = 0; i < moduleElements.length; i++) {
			const module = moduleElements[i];
			const lineNumber = module.lineNumber - 1;
			const resourceRef = module.getAttribute('resourceref');

			if (resourceRef) {
				const activeRange = new vscode.Range(lineNumber, 0, lineNumber, 0);
				const activeEditorPath = vscode.window.activeTextEditor.document.uri.fsPath;
				const directoryPath = activeEditorPath.substring(0, activeEditorPath.lastIndexOf('/'));
				const dapsConfig = vscode.workspace.getConfiguration('daps');
				// Add peek action
				if (dapsConfig.get('showAssemblyCodelens') == 'peek'
					|| dapsConfig.get('showAssemblyCodelens') == 'both') {
					const peekUri = vscode.Uri.file(`${directoryPath}/${resources[resourceRef]}`);
					codeLenses.push(new vscode.CodeLens(activeRange, {
						title: `Peek into ${path.basename(resources[resourceRef])} `,
						command: "editor.action.peekLocations",
						arguments: [document.uri, activeRange.start, [new vscode.Location(peekUri, new vscode.Range(0, 0, 15, 0))]]
					}));
				}

				// Add open action 
				if (dapsConfig.get('showAssemblyCodelens') == 'link'
					|| dapsConfig.get('showAssemblyCodelens') == 'both') {
					codeLenses.push(new vscode.CodeLens(activeRange, {
						title: "Open in a new tab",
						command: 'daps.openFile',
						arguments: [`${directoryPath}/${resources[resourceRef]}`]
					}));
				}
			}
		}
		return codeLenses;
	}
}

/**
 * Provides a CodeLens provider that displays references to cross-references (xrefs) in the editor.
 * The provider scans the current workspace for files containing xrefs and generates CodeLens items
 * that allow the user to peek at or open the referenced content.
 */
class xrefCodeLensProvider {
	constructor(context) {
		this.context = context;
		this.dapsConfig = vscode.workspace.getConfiguration('daps');
		this.excludeDirs = this.dapsConfig.get('xrefCodelensExcludeDirs');
		this._cachedCodeLenses = new Map();

		// Event emitter to trigger code lens updates
		this._onDidChangeCodeLensesEmitter = new vscode.EventEmitter();
		this.onDidChangeCodeLenses = this._onDidChangeCodeLensesEmitter.event;

		// Listen for save events to refresh the CodeLenses
		vscode.workspace.onDidSaveTextDocument((document) => {
			const pattern = "**/*.{xml,adoc}";
			if (vscode.languages.match({ pattern }, document)) {
				this.refresh(document);
			}
		});
	}

	provideCodeLenses(document) {
		// Return cached CodeLenses if available
		const cached = this._cachedCodeLenses.get(document.uri.toString());
		if (cached) {
			return cached;
		}

		// If no cache is available, return an empty array
		return [];
	}

	refresh(document) {
		// Recompute CodeLenses and cache them
		const codeLenses = this._computeCodeLenses(document);
		this._cachedCodeLenses.set(document.uri.toString(), codeLenses);

		// Notify VSCode to refresh CodeLenses
		this._onDidChangeCodeLensesEmitter.fire();
	}

	_computeCodeLenses(document) {
		dbg(`codelens:xrefCodelensExcludeDirs: ${this.excludeDirs}`);
		const fileType = document.languageId;
		dbg(`codelens:xref:languageId: ${fileType}`);
		const xrefElements = this._extractXrefElements(document, fileType);

		dbg(`codelens:xref:xrefElements.length: ${xrefElements.length}`);
		const workspaceFolderUri = vscode.workspace.workspaceFolders[0].uri; // Assuming single-root workspace
		const codeLenses = [];

		for (let i = 0; i < xrefElements.length; i++) {
			const xrefLinkend = this._getXrefLinkend(xrefElements[i], fileType);
			dbg(`codelens:xref:xrefLinkend: ${xrefLinkend}`);
			const matchedReferers = searchInFiles(
				workspaceFolderUri.fsPath,
				this.excludeDirs,
				this._getSearchPattern(xrefLinkend, fileType),
				fileType === "asciidoc" ? /\.adoc$/ : /\.xml$/
			);

			dbg(`codelens:xref:matchedReferers: ${matchedReferers.length}`);

			const lineNumber = xrefElements[i].lineNumber - (fileType === "xml" ? 1 : 0);
			const columnNumber = xrefElements[i].columnNumber;
			const activeRange = new vscode.Range(
				new vscode.Position(lineNumber, columnNumber),
				new vscode.Position(lineNumber, columnNumber)
			);

			matchedReferers.forEach((referer, index) => {
				dbg(`codelens:xref:matchedReferer ${index}: ${referer.file}`);

				if (this.dapsConfig.get('showXrefCodelens') === 'peek' || this.dapsConfig.get('showXrefCodelens') === 'both') {
					const codeLensPeek = this._createPeekCodeLens(document, activeRange, referer);
					codeLenses.push(codeLensPeek);
				}

				if (this.dapsConfig.get('showXrefCodelens') === 'link' || this.dapsConfig.get('showXrefCodelens') === 'both') {
					const codeLensOpen = this._createOpenCodeLens(activeRange, referer);
					codeLenses.push(codeLensOpen);
				}

				dbg(`codelens:xref:codeLenses.length: ${codeLenses.length}`);
			});
		}

		return codeLenses;
	}

	_extractXrefElements(document, fileType) {
		if (fileType === "asciidoc") {
			return this._parseAsciidocXrefs(document);
		} else if (fileType === "xml") {
			const text = parser.parseFromString(document.getText());
			return Array.from(text.getElementsByTagName('xref'));
		}
		return [];
	}

	_parseAsciidocXrefs(document) {
		const text = document.getText();
		const regex = /<<([^,>]+)(?:,([^>]*))?>>/g;
		const xrefElements = [];
		let match;

		while ((match = regex.exec(text)) !== null) {
			xrefElements.push({
				lineNumber: document.positionAt(match.index).line,
				columnNumber: document.positionAt(match.index).character,
				match: match[1],
				title: match[2] || null
			});
		}
		return xrefElements;
	}

	_getXrefLinkend(xrefElement, fileType) {
		if (fileType === "asciidoc") {
			return xrefElement.match;
		} else if (fileType === "xml") {
			return xrefElement.getAttribute('linkend');
		}
		return null;
	}

	_getSearchPattern(xrefLinkend, fileType) {
		if (fileType === "asciidoc") {
			return `\\[#(${xrefLinkend})(?:,([^\\]]*))?\\]`;
		} else if (fileType === "xml") {
			return `xml:id=\"${xrefLinkend}\"`;
		}
		return null;
	}

	_createPeekCodeLens(document, activeRange, referer) {
		const activeUri = document.uri;
		const peekRange = new vscode.Range(
			new vscode.Position(referer.line, 0),
			new vscode.Position(referer.line + 15, 0)
		);
		const peekUri = vscode.Uri.file(referer.file);
		const peekLocation = new vscode.Location(peekUri, peekRange);

		return new vscode.CodeLens(activeRange, {
			title: `Peek into ${path.basename(referer.file)}`,
			command: "editor.action.peekLocations",
			arguments: [activeUri, activeRange.start, [peekLocation]]
		});
	}

	_createOpenCodeLens(activeRange, referer) {
		return new vscode.CodeLens(activeRange, {
			title: "Open in a new tab",
			command: 'daps.openFile',
			arguments: [referer.file, referer.line]
		});
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
	const dapsConfig = vscode.workspace.getConfiguration('daps');
	/**
	 * E V E N T S    L I S T E N I N G
	 */
	// when saving active editor:
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((document) => {
			updateEntityDiagnostics(document);
			// update scrollmap
			const fileName = document.uri.path;
			const scrollMap = createScrollMap(fileName);
			dbg(`saved document: ${fileName}`);
			// refresh HTML preview
			if (fileName == getActiveFile() && previewPanel) {
				vscode.commands.executeCommand('daps.docPreview');
				previewPanel.webview.postMessage({ command: 'updateMap', map: scrollMap });
			}
			// refresh doc structure treeview
			vscode.commands.executeCommand('docStructureTreeView.refresh');
		}));
	// when closing active editor:
	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument(() => {
			// clear the scroll map for HTML preview
			let scrollMap = {};
		}));
	// when active editor is changed:
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((activeEditor) => {
			if (activeEditor && activeEditor.document.languageId === 'xml') {
				// refresh doc structure treeview
				updateEntityDiagnostics(activeEditor.document);
				vscode.commands.executeCommand('docStructureTreeView.refresh');
				// create scroll map for HTML preview
				createScrollMap();
			}
		}));
	// when the visible editors change
	context.subscriptions.push(
		vscode.window.onDidChangeVisibleTextEditors(() => {
			// ensure the tree view is cleared when the last XML editor is closed and updated 
			vscode.commands.executeCommand('docStructureTreeView.refresh');
		})
	);

	const entityDiagnostics = vscode.languages.createDiagnosticCollection("entities");
	context.subscriptions.push(entityDiagnostics);

	/**
	 * Analyzes the document for strings that can be replaced by an XML entity and creates diagnostics.
	 * @param {vscode.TextDocument} document The document to analyze.
	 */
	function updateEntityDiagnostics(document) {
		// Get the extension's configuration to check if the feature is enabled.
		const dapsConfig = vscode.workspace.getConfiguration('daps');
		if (!dapsConfig.get('replaceWithXMLentity') || document.languageId !== 'xml') {
			// If the feature is disabled or the file is not XML, clear any existing diagnostics and exit.
			entityDiagnostics.clear();
			return;
		}

		// Generate the map of replaceable string values to their corresponding entity names.
		const entityValueMap = createEntityValueMap(document.fileName);
		if (entityValueMap.size === 0) {
			// If no entities are found, clear diagnostics and exit.
			entityDiagnostics.clear();
			return;
		}

		const diagnostics = [];
		// Keep track of ranges that have already been diagnosed to avoid overlapping suggestions.
		const diagnosedRanges = [];
		const text = document.getText();

		// Convert the map to an array and sort it by the length of the entity value in descending order.
		// This ensures that longer, more specific phrases (including multiline ones) are matched first.
		const sortedEntities = Array.from(entityValueMap.entries()).sort((a, b) => b[0].length - a[0].length);

		sortedEntities.forEach(([entityValue, entityName]) => {
			// Escape special characters in the entity value for use in a regular expression.
			// Then, replace spaces with `\s+` to match any whitespace sequence (including newlines).
			const pattern = entityValue
				.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') // Escape regex special characters.
				.replace(/\s+/g, '\\s+');
			const regex = new RegExp(pattern, 'g');
			let match;

			while ((match = regex.exec(text)) !== null) {
				const startPos = document.positionAt(match.index);
				const endPos = document.positionAt(match.index + match[0].length);
				const range = new vscode.Range(startPos, endPos);
				
				// Check if the new range overlaps with any range that has already been diagnosed.
				// This prevents suggesting a replacement for "SUSE" if "SUSE Observability" has already been matched.
				const isOverlapping = diagnosedRanges.some(diagnosedRange => range.intersection(diagnosedRange));

				// If there is no overlap, create and add the new diagnostic.
				if (!isOverlapping) {
					// Create a new diagnostic (the underline and suggestion in the editor).
					const diagnostic = new vscode.Diagnostic(
						range,
						`Replace with entity ${entityName}`,
						vscode.DiagnosticSeverity.Information
					);
					diagnostic.code = 'replaceWithEntity';
					diagnostic.source = 'DAPS';
					diagnostics.push(diagnostic);
					// Add the range to our list of diagnosed ranges to prevent overlaps.
					diagnosedRanges.push(range);
				}
			}
		});

		// Apply the collected diagnostics to the document.
		entityDiagnostics.set(document.uri, diagnostics);
	}

	// Register a Code Actions Provider to offer a "Quick Fix" for our entity diagnostics.
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider('xml', {
			// This function is called by VS Code when the user clicks the lightbulb icon.
			provideCodeActions(document, range, context, token) {
				const codeActions = [];
				// Filter the diagnostics at the cursor position to only include our entity replacement suggestions.
				context.diagnostics
					.filter(diagnostic => diagnostic.code === 'replaceWithEntity')
					.forEach(diagnostic => {
						// Extract the entity name (e.g., "&sliberty;") from the diagnostic message.
						const entityName = diagnostic.message.split(' ')[3];
						// Create a new CodeAction, which is the "Quick Fix" item in the menu.
						const action = new vscode.CodeAction(`Replace with ${entityName}`, vscode.CodeActionKind.QuickFix);
						// Create a WorkspaceEdit to define the text change (replace the string with the entity).
						action.edit = new vscode.WorkspaceEdit();
						action.edit.replace(document.uri, diagnostic.range, entityName);
						// Associate this action with the specific diagnostic it fixes.
						action.diagnostics = [diagnostic];
						// Mark this as the preferred action.
						action.isPreferred = true;
						codeActions.push(action);
					});
				return codeActions;
			}
		})
	);
	/**
	  * Focuses the active editor on the specified line number.
	  * 
	  * This command is used to move the cursor and scroll the editor to the specified line number in the active text editor.
	  * If the 'onClickedStructureItemMoveCursor' configuration option is enabled, the cursor will be moved to the specified line.
	  * Otherwise, the editor will be scrolled to reveal the specified line.
	  * 
	  * @param {number} lineNumber - The line number to focus in the active editor.
	  */
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
	/**
	  * Registers a command to open a file in the editor with a peek view.
	  *
	  * This command is used to open a file in the editor and display a peek view of the specified range of the file.
	  * The peek view allows the user to quickly view the contents of the file without switching to the full editor.
	  *
	  * @param {string} filePath - The path of the file to open.
	  * @param {vscode.Range} range - The range of the file to display in the peek view.
	  */
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

	/**
	 * Registers a code lens provider for assembly modules in the DAPS (DocBook Authoring and Publishing Suite) extension.
	 * The code lens provider is responsible for displaying code lens information for assembly modules in XML and Asciidoc files.
	 * The code lens information is displayed above the assembly module declarations and provides a way for users to navigate to the
	 * referenced assembly modules.
	 */
	context.subscriptions.push(vscode.languages.registerCodeLensProvider({
		pattern: dapsConfigGlobal.get('dbAssemblyPattern')
	}, new assemblyModulesCodeLensesProvider(context)));

	/**
	 * Registers a code lens provider for XML and Asciidoc files in the DAPS (DocBook Authoring and Publishing Suite) extension.
	 * The code lens provider is responsible for displaying code lens information for cross-references (xrefs) in these file types.
	 * The code lens information is displayed above the xref declarations and provides a way for users to navigate to the
	 * referenced content.
	*/
	context.subscriptions.push(vscode.languages.registerCodeLensProvider({
		pattern: "**/*.{xml,adoc}"
	}, new xrefCodeLensProvider(context)));

	/**
	 * enable autocomplete XML entities from external files
	 */
	if (dapsConfig.get('autocompleteXMLentities')) {
		dbg(`autocompleteXMLentities: ${dapsConfig.get('autocompleteXMLentities')}`)
		context.subscriptions.push(vscode.languages.registerCompletionItemProvider('xml', {
			provideCompletionItems(document, position, token, context) {
				dbg(`entity:doc: ${document.fileName}, pos: ${position.line}, token: ${token.isCancellationRequested}, context: ${context.triggerKind}`);

				// Get array of entity files
				let entityFiles = getXMLentityFiles(document.fileName);
				dbg(`entity:Number of entity files: ${entityFiles.length}`);

				// Extract entities from entity files
				let entities = getXMLentites(entityFiles);
				dbg(`entity:Number of entities: ${entities.length}`);

				let result = [];
				entities.forEach(entity => {
					dbg(`entity:entity ${entity}`)
					let completionItem = new vscode.CompletionItem(entity);
					completionItem.label = `&${entity}`;
					dbg(`entity:completionItem.label ${completionItem.label}`)
					completionItem.kind = vscode.CompletionItemKind.Keyword;
					dbg(`entity:completionItem.kind ${completionItem.kind}`)
					completionItem.filterText = entity.substring(-1);
					dbg(`entity:completionItem.filterText ${completionItem.filterText}`)

					// Adjust `insertText` based on the trigger context
					const lineText = document.lineAt(position).text;
					dbg(`entity:lineText ${lineText}`);
					const textBeforeCursor = lineText.slice(0, position.character);
					dbg(`entity:textBeforeCursor ${textBeforeCursor}`);
					const indexOfAmpersand = textBeforeCursor.lastIndexOf('&');
					dbg(`entity:indexOfAmpersand ${indexOfAmpersand}`);
					const textFromAmpersand = indexOfAmpersand !== -1 ? textBeforeCursor.slice(indexOfAmpersand) : '';
					dbg(`entity:textFromAmpersand ${textFromAmpersand}`);
					const charBeforeCursor = lineText[position.character - 1] || '';
					dbg(`entity:charBeforeCursor ${charBeforeCursor}`);

					// If the context was triggered by `&`, only insert the entity itself
					if (charBeforeCursor === '&' || textFromAmpersand) {
						completionItem.insertText = new vscode.SnippetString(entity);
					} else {
						completionItem.insertText = new vscode.SnippetString(`&${entity}`);
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
	context.subscriptions.push(vscode.commands.registerCommand('daps.docPreview', function docPreview(contextFileURI) {
		// get img src path from config
		const dapsConfig = vscode.workspace.getConfiguration('daps');
		// path to images
		let docPreviewImgPath = dapsConfig.get('docPreviewImgPath');
		dbg(`preview:docPreviewImgPath ${docPreviewImgPath}`);
		const activeEditorDir = getActiveEditorDir();
		dbg(`preview:activeEditorDir ${activeEditorDir}`);
		// create a new webView if it does not exist yet
		if (previewPanel === undefined) {
			previewPanel = vscode.window.createWebviewPanel(
				'htmlPreview', // Identifies the type of the webview
				'HTML Preview', // Title displayed in the panel
				vscode.ViewColumn.Two, // Editor column to show the webview panel
				{
					enableScripts: true,
					localResourceRoots: [vscode.Uri.file(path.join(activeEditorDir, docPreviewImgPath))]
				}
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
		// Update <img/> tags for webview, create a regex to match <img src="...">
		const imageRegex = /<img src="([^"]+)"/g;
		// Replace all image src attributes
		htmlContent = htmlContent.replace(imageRegex, (match, src) => {
			var imgURI = undefined;
			// For each image, create the path to the image
			imgUri = vscode.Uri.file(path.join(activeEditorDir, docPreviewImgPath, src));
			dbg(`preview:imgUri ${imgUri}`);
			// check if imgURI extsts and if not, check SVG variant
			if (!fs.existsSync(imgUri.path)) {
				const svgPath = imgUri.path.replace(/\.[^/.]+$/, ".svg");
				dbg(`preview:svgPath: ${svgPath}`);
				if (fs.existsSync(svgPath)) {
					imgUri = vscode.Uri.file(svgPath);
				} else {
					dbg(`preview:imgUri: Neither ${imgUri.path} nor ${svgPath} exist`)
				}
			}
			dbg(`preview:final imgUri: ${imgUri}`);
			// create img URI that the webview can swollow
			const imgWebviewUri = previewPanel.webview.asWebviewUri(imgUri);
			dbg(`preview:imgWebviewUri ${imgWebviewUri}`);
			// Return the updated <img> tag with the new src
			return `<img src="${imgWebviewUri}"`;
		});
		//compile the whole HTML for webview
		let html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HTML Preview</title>
</head>
<body>
  <!-- Your preview content goes here -->
  <div id="content">
    ${htmlContent}
  </div>
  <script>
const vscode = acquireVsCodeApi();
const srcXMLfile = "${srcXMLfile}";
let scrollMap = []; // Scroll map sent from the extension
let isProgrammaticScroll = false; // Flag to track programmatic scrolling

// Handle messages sent from the extension to the webview
window.addEventListener('message', event => {
    const message = event.data; // The JSON data sent by the extension
    switch (message.command) {
        case 'updateMap':
            scrollMap = message.map;
            // Enhance the scrollMap with dynamically calculated offsets
            scrollMap = scrollMap.map(entry => {
                const element = document.getElementById(entry.id);
                return {
                    ...entry,
                    offset: element ? element.offsetTop : 0
                };
            });
            console.log(scrollMap);
            break;
        case 'syncScroll':
            // Scroll to a specific line programmatically
            const lineToElement = scrollMap.find(item => item.line === message.line);
            if (lineToElement) {
                const element = document.getElementById(lineToElement.id);
                if (element) {
                    isProgrammaticScroll = true; // Set the flag to ignore the scroll event
                    element.scrollIntoView({ behavior: 'smooth' });
                }
            }
            break;
    }
});

// Send scroll messages to the extension
document.addEventListener('scroll', () => {
    if (isProgrammaticScroll) {
        // Reset the flag and ignore this scroll event
        isProgrammaticScroll = false;
        return;
    }

    const scrollPosition = window.scrollY;

    // Find the appropriate line based on scroll position
    let lineToScroll = null;
    for (let i = 0; i < scrollMap.length - 1; i++) {
        if (
            scrollPosition >= scrollMap[i].offset &&
            scrollPosition < scrollMap[i + 1].offset
        ) {
            lineToScroll = scrollMap[i].line;
            break;
        }
    }

    // Send message only if a matching line was found
    if (lineToScroll !== null) {
        console.log({
            command: 'scroll',
            position: scrollPosition,
            line: lineToScroll,
            srcXMLfile: srcXMLfile
        });
        vscode.postMessage({
            command: 'scroll',
            position: scrollPosition,
            line: lineToScroll,
            srcXMLfile: srcXMLfile
        });
    }
});
</script>

</body>
</html>`;
		const scrollMap = createScrollMap(vscode.window.activeTextEditor.document.fileName);
		dbg(`preview:scrollmap:length ${scrollMap.length}`);

		previewPanel.webview.html = html;
		previewPanel.webview.postMessage({ command: 'updateMap', map: scrollMap });
		previewPanel.onDidDispose(() => {
			previewPanel = undefined;
		});

		// listen to scroll messages from the active editor
		vscode.window.onDidChangeTextEditorVisibleRanges(event => {
			const editor = event.textEditor;
			const topLine = editor.visibleRanges[0].start.line;
			previewPanel.webview.postMessage({ command: 'syncScroll', line: topLine });
		});
		// Listen to scroll messages from the WebView
		let previewLinkScrollBoth = dapsConfig.get('previewLinkScrollBoth');
		if (previewLinkScrollBoth) {
			previewPanel.webview.onDidReceiveMessage(async (message) => {
				switch (message.command) {
					case 'scroll': {
						const scrollPosition = message.position;
						dbg(`preview:scrollPosition ${scrollPosition}`);

						const srcXMLfile = message.srcXMLfile;
						dbg(`preview:srcXMLfile ${srcXMLfile}`);

						const lineToScroll = message.line;
						dbg(`preview:scroll:lineToScroll ${lineToScroll}`);

						if (lineToScroll !== undefined) {
							// Ensure the correct editor is opened
							const fileUri = vscode.Uri.file(srcXMLfile);

							// Check if the document is already open
							let targetEditor = vscode.window.visibleTextEditors.find(editor =>
								editor.document.uri.fsPath === fileUri.fsPath
							);

							if (!targetEditor) {
								// Open the file if it is not already open
								const document = await vscode.workspace.openTextDocument(fileUri);
								targetEditor = await vscode.window.showTextDocument(document);
							}

							if (targetEditor) {
								const position = new vscode.Position(lineToScroll - 1, 0); // Convert 1-based to 0-based
								const range = new vscode.Range(position, position);
								targetEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
							}
						}
						break;
					}
				}
			}, undefined, context.subscriptions);
		}
	}));

	/**
	 * Command to replace strings with their corresponding XML entities.
	 */
	context.subscriptions.push(vscode.commands.registerCommand('daps.replaceWithEntity', async () => {
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.languageId === 'xml') {
			const entityValueMap = createEntityValueMap(editor.document.fileName);
			if (entityValueMap.size > 0) {
				const edit = new vscode.WorkspaceEdit();
				let text = editor.document.getText();

				entityValueMap.forEach((entityName, entityValue) => {
					const regex = new RegExp(entityValue.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
					text = text.replace(regex, entityName);
				});

				const fullRange = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));
				edit.replace(editor.document.uri, fullRange, text);
				await vscode.workspace.applyEdit(edit);
			}
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

/**
 * create scroll map for HTMl preview
 */
function createScrollMap(fileName) {
	var docContent = fs.readFileSync(fileName, 'utf-8');
	dbg(`scrollmap:filename ${fileName}`);
	let scrollMap = [];
	dbg(`scrollmap:docContent length ${docContent.length}`);
	const lines = docContent.split('\n');
	dbg(`scrollmap:docContent:lines ${lines.length}`);
	for (let index = 0; index < lines.length; index++) {
		let idMatch = lines[index].match(/xml:id="([^"]+)"/i);
		if (idMatch) {
			let idValue = idMatch[1];
			dbg(`scrollmap:idValue ${idValue}`);
			scrollMap.push({
				line: index + 1, // Line number (1-based index)
				id: idValue
			});
		}
	}
	dbg(`scrollmap:length ${scrollMap.length}`);
	return scrollMap;
}

//debugging
function dbg(msg) {
	const dapsConfig = vscode.workspace.getConfiguration('daps');
	if (dapsConfig.get('enableDbg') == 'output') {
		dbgChannel.appendLine(`dbg:daps: ${msg}`);
	} else if (dapsConfig.get('enableDbg') == 'console') {
		console.log(`dbg:daps ${msg}`);
	} else if (dapsConfig.get('enableDbg') == 'both') {
		dbgChannel.appendLine(`dbg:daps ${msg}`);
		console.log(`dbg:daps ${msg}`);
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

/**
 * Extracts a list of XML entity names from the provided entity files.
 *
 * @param {string[]} entityFiles - An array of file paths containing XML entity definitions.
 * @returns {string[]} - An array of XML entity names.
 */
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

/**
 * Retrieves all elements from the given root element that have a tag name
 * included in the provided allowedTagNames array.
 *
 * @param {Element} rootElement - The root element to search for allowed elements.
 * @param {string[]} allowedTagNames - An array of tag names to include in the result.
 * @returns {Element[]} - An array of elements that have an allowed tag name.
 */
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

/**
 * Returns the directory path of the active editor file.
 * @returns {string|boolean} The directory path of the active editor file, or `false` if the active editor cannot be found.
 */
function getActiveEditorDir() {
	const activeEditorPath = vscode.window.activeTextEditor.document.uri.fsPath;
	if (!activeEditorPath) {
		dbg(`Cannot find active editor`);
		return false;
	}
	const directoryPath = activeEditorPath.substring(0, activeEditorPath.lastIndexOf('/'));
	return directoryPath;
}

/**
	* Search for a specific string in files matching a pattern within a directory.
	* @param {string} rootDir - The directory to search within.
	* @param {array} excludeDirs - Array of directory names to exclude from searching.
	* @param {string} searchTerm - The string to search for.
	* @param {RegExp} filePattern - The pattern to match files.
	* @returns {Array} - An array of search results.
	*/
function searchInFiles(rootDir, excludeDirs, searchTerm, filePattern) {
	let results = [];
	const files = fs.readdirSync(rootDir);

	files.forEach(file => {
		const filePath = path.join(rootDir, file);
		dbg(`searchInFiles:filePAth ${filePath}`);
		const stats = fs.statSync(filePath);

		if (stats.isDirectory()) {
			// Skip directories that begin with a period
			if (path.basename(filePath).startsWith('.')) {
				return;
			}
			// skip directories that are to be excluded
			if (excludeDirs.includes(path.basename(filePath))) {
				dbg(`codelens:xref skipping exclideDir: ${path.basename(filePath)}`);
				return;
			}
			// Recursive call for subdirectories
			results = results.concat(searchInFiles(filePath, excludeDirs, searchTerm, filePattern));
		} else if (filePattern.test(filePath)) {
			const content = fs.readFileSync(filePath, 'utf8');
			const lines = content.split('\n');
			const regex = new RegExp(searchTerm, 'g');
			lines.forEach((line, lineNumber) => {
				while ((match = regex.exec(line)) !== null) {
					results.push({
						file: filePath,
						line: lineNumber,
						column: match.index,
						match: match[1], // section-id
					});
				}
			});
		}
	});
	return results;
}

/**
 * Processes all included entity files and parses each file to extract individual entities
 * into a map where the key is the entity's value and the value is the entity's name.
 * For example, `<!ENTITY sliberty "&suse; Liberty Linux">` would be mapped as
 * `"&suse; Liberty Linux"` -> `&sliberty`.
 *
 * @param {string} documentFileName The path to the document file to get entity files for.
 * @returns {Map<string, string>} A map from entity values to entity names.
 */
function createEntityValueMap(documentFileName) {
	// Get a list of all XML entity files associated with the current document.
	const entityFiles = getXMLentityFiles(documentFileName);
	// This map will store the initial name-to-value mapping, e.g., 'sliberty' -> '&suse; Liberty Linux'.
	const nameToValueMap = new Map();

	// --- 1. First pass: Collect all raw entity definitions from all entity files. ---
	entityFiles.forEach(entFile => {
		try {
			// Read the content of the entity file.
			const fileContent = fs.readFileSync(entFile, 'utf8');
			// Regular expression to capture an entity's name and its value, excluding complex values.
			// The 'g' flag allows finding all matches, and 's' (dotAll) allows '.' to match newlines.
			const entityRegex = /<!ENTITY\s+([^\s]+)\s+"([^"<>\[\]]+)"/gs;
			let match;

			// Process the entire file content to find all entity definitions.
			while ((match = entityRegex.exec(fileContent)) !== null) {
				const [, entityName, entityValue] = match;

				// Exclude entities that contain numeric character references (e.g., &#x000AE;).
				if (/&#\S+;/.test(entityValue)) {
					dbg(`Skipping entity '${entityName}' because its value contains a numeric character reference.`);
					continue;
				}

				// Replace &nbsp; with a regular space and &reg; with * to avoid resolution issues.
				const cleanedValue = entityValue.replace(/&nbsp;/g, ' ').replace(/&reg;/g, '*');
				// Store the raw (but cleaned) entity definition.
				nameToValueMap.set(entityName, cleanedValue);
			}
		} catch (error) {
			// Log any errors that occur during file reading or parsing.
			dbg(`Error reading or parsing entity file ${entFile}: ${error.message}`);
		}
	});

	// --- 2. Second pass: Resolve nested entities and create the final value-to-name map. ---
	// This map will store the final, fully resolved value to its entity name, e.g., 'SUSE Liberty Linux' -> '&sliberty;'.
	const entityValueMap = new Map();
	// Regex to find entity references (e.g., &entityname;) within a string.
	const entityRegex = /&([a-zA-Z0-9_.-]+);/g;

	// Iterate over the raw entities collected in the first pass.
	for (const [entityName, entityValue] of nameToValueMap.entries()) {
		let resolvedValue = entityValue;
		let match;
		// Use a Set to track entities seen during the resolution of a single value to detect circular references.
		const seen = new Set();

		// Keep replacing entities until no more can be found or a circular dependency is detected.
		while ((match = entityRegex.exec(resolvedValue)) !== null) {
			// The name of the nested entity to be replaced (e.g., 'suse' from '&suse;').
			const nestedEntityName = match[1];

			// Check for circular references (e.g., <!ENTITY a "&b;"> and <!ENTITY b "&a;">).
			if (seen.has(nestedEntityName)) {
				dbg(`Circular entity reference detected for '${nestedEntityName}' in '${entityName}'. Skipping further resolution.`);
				break; // Avoid infinite loop
			}
			seen.add(nestedEntityName);

			// If the nested entity exists in our map, replace it with its value.
			if (nameToValueMap.has(nestedEntityName)) {
				resolvedValue = resolvedValue.replace(match[0], nameToValueMap.get(nestedEntityName));
				entityRegex.lastIndex = 0; // Reset regex index to re-scan the modified string
			}
		}

		// Store the fully resolved value and its corresponding entity name in the final map.
		entityValueMap.set(resolvedValue, `&${entityName};`);
	}
	dbg(`Number of entity pairs: ${entityValueMap.size}`);

	return entityValueMap;
}

// This method is called when your extension is deactivated
function deactivate() { }

module.exports = {
	activate,
	deactivate
}
