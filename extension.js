const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { DOMParser } = require('@xmldom/xmldom');
const parser = new DOMParser({ errorHandler: { warning: null }, locator: {} }, { ignoreUndefinedEntities: true });
const execSync = require('child_process').execSync;
const buildTargets = ['html', 'pdf'];

// TODO: turn all execSync calls to asynchronous
// TODO: break down God complex functions

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
			const pattern = vscode.workspace.getConfiguration('daps').get('dbAssemblyPattern');
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
			const showAssemblyCodelens = vscode.workspace.getConfiguration('daps').get('showAssemblyCodelens');
				// Add peek action
			if (showAssemblyCodelens == 'peek'
				|| showAssemblyCodelens == 'both') {
					const peekUri = vscode.Uri.file(`${directoryPath}/${resources[resourceRef]}`);
					codeLenses.push(new vscode.CodeLens(activeRange, {
						title: `Peek into ${path.basename(resources[resourceRef])} `,
						command: "editor.action.peekLocations",
						arguments: [document.uri, activeRange.start, [new vscode.Location(peekUri, new vscode.Range(0, 0, 15, 0))]]
					}));
				}

				// Add open action 
			if (showAssemblyCodelens == 'link'
				|| showAssemblyCodelens == 'both') {
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
		const dapsConfig = vscode.workspace.getConfiguration('daps');
		const excludeDirs = dapsConfig.get('xrefCodelensExcludeDirs');
		dbg(`codelens:xrefCodelensExcludeDirs: ${excludeDirs}`);
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
				excludeDirs,
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

				const showXrefCodelens = dapsConfig.get('showXrefCodelens');
				if (showXrefCodelens === 'peek' || showXrefCodelens === 'both') {
					const codeLensPeek = this._createPeekCodeLens(document, activeRange, referer);
					codeLenses.push(codeLensPeek);
				}

				if (showXrefCodelens === 'link' || showXrefCodelens === 'both') {
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
	dbgChannel = vscode.window.createOutputChannel('DAPS');
	dbg('Congratulations, your extension "daps" is now active!');
	dbg('Debug channel opened');
	var extensionPath = context.extensionPath;
	dbg(`Extension path: ${extensionPath}`);
	

	/**
	 * Finds or creates the DAPS terminal instance.
	 * @returns {vscode.Terminal} The DAPS terminal.
	 */
	function getDapsTerminal() {
		for (let i = 0; i < vscode.window.terminals.length; i++) {
			if (vscode.window.terminals[i].name === 'DAPS') {
				return vscode.window.terminals[i];
			}
		}
		return vscode.window.createTerminal('DAPS');
	}

	// Manager for the HTML preview panel state
	const previewManager = {
		panel: undefined,
		dispose: function () {
			this.panel = undefined;
		}
	};

	/**
	 * E V E N T S    L I S T E N I N G
	 */
	// when saving active editor:
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((document) => {			// update scrollmap
			const fileName = document.uri.path;
			const scrollMap = createScrollMap(fileName);
			// refresh HTML preview
			if (fileName == getActiveFile() && previewManager.panel) {
				vscode.commands.executeCommand('daps.docPreview');
				previewManager.panel.webview.postMessage({ command: 'updateMap', map: scrollMap });
			}
			// refresh doc structure treeview
			vscode.commands.executeCommand('docStructureTreeView.refresh');
		}));
	// when opening a document:
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument((document) => {
			updateEntityDiagnostics(document);
			updateAttributeDiagnostics(document);
		})
	);
	// when closing active editor:
	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument(() => {
			// clear the scroll map for HTML preview
			let scrollMap = {};
		}));
	// when active editor is changed:
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((activeEditor) => {
			if (activeEditor) {
				const document = activeEditor.document;
				// refresh doc structure treeview
				vscode.commands.executeCommand('docStructureTreeView.refresh');
				// create scroll map for HTML preview
				createScrollMap(document.fileName);
			}
		}));
	// when the visible editors change
	context.subscriptions.push(
		vscode.window.onDidChangeVisibleTextEditors(() => {
			// ensure the tree view is cleared when the last XML editor is closed and updated 
			vscode.commands.executeCommand('docStructureTreeView.refresh');
		})
	);
	// when the document is changed (with debounce)
	let diagnosticUpdateTimeout;
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(event => {
			if (event.document.uri.scheme === 'file' && (event.document.languageId === 'xml' || event.document.languageId === 'asciidoc')) {
				clearTimeout(diagnosticUpdateTimeout);
				diagnosticUpdateTimeout = setTimeout(() => {
					dbg('Running debounced diagnostic update.');
					updateEntityDiagnostics(event.document);
					updateAttributeDiagnostics(event.document);
				}, 500); // 500ms delay
			}
		})
	);


	const entityDiagnostics = vscode.languages.createDiagnosticCollection("entities");
	context.subscriptions.push(entityDiagnostics);

	const attributeDiagnostics = vscode.languages.createDiagnosticCollection("attributes");
	context.subscriptions.push(attributeDiagnostics);

	// Initial check for documents that are already open when the extension activates
	if (vscode.window.activeTextEditor) {
		updateEntityDiagnostics(vscode.window.activeTextEditor.document);
		updateAttributeDiagnostics(vscode.window.activeTextEditor.document);
	}

	/**
	 * Executes a DAPS command with error handling.
	 *
	 * @param {string} command - The DAPS command to execute.
	 * @param {string} successMessage - The message to display on success.
	 * @param {function} successCallback - An optional callback function to execute on success.
	 * @returns {boolean} - True if the command executed successfully, false otherwise.
	 */
	async function executeDapsCommand(command, successMessage, successCallback) {
		if (!vscode.workspace.workspaceFolders) {
			vscode.window.showErrorMessage("Cannot run DAPS command: No workspace folder is open.");
			return false;
		}
		const workspaceFolderUri = vscode.workspace.workspaceFolders[0].uri;
		const dapsConfig = vscode.workspace.getConfiguration('daps');
		try {
			// Change working directory to current workspace
			process.chdir(workspaceFolderUri.path);
			dbg(`cwd is ${workspaceFolderUri.path}`);

			// Execute the command in a terminal or via execSync
			if (dapsConfig.get('runTerminal')) {
				const terminal = getDapsTerminal();
				dbg('Running command in terminal');
				terminal.sendText(command);
				terminal.show(true);
			} else {
				vscode.window.showInformationMessage(`Running ${command}`);
				let cmdOutput = execSync(command);
				if (successCallback) {
					await successCallback(cmdOutput);
				}
				vscode.window.showInformationMessage(successMessage);
			}
			return true;
		} catch (err) {
			vscode.window.showErrorMessage(`Command failed: ${err}`);
			return false;
		}
	}



	/**
	 * Analyzes the document for strings that can be replaced by an XML entity and creates diagnostics.
	 * @param {vscode.TextDocument} document The document to analyze.
	 */
	function updateEntityDiagnostics(document) {
		// Get the extension's configuration to check if the feature is enabled.
		const dapsConfig = vscode.workspace.getConfiguration('daps');
		const replaceWithXMLentity = dapsConfig.get('replaceWithXMLentity');
		if (!replaceWithXMLentity || document.languageId !== 'xml') {
			// If the feature is disabled or the file is not XML, clear any existing diagnostics and exit.
			entityDiagnostics.clear();
			return;
		}

		// Define tags inside which entity replacement should be skipped.
		const noReplaceTags = dapsConfig.get('replaceWithXMLentityIgnoreTags');
		const noReplaceRanges = [];
		// Define phrases that should be skipped from replacing with an entity or attribute.
		const ignorePhrases = dapsConfig.get('replaceWithIgnorePhrases');

		const text = document.getText();

		// 1. Find content of no-replace tags.
		const noReplaceRegex = new RegExp(`<(${noReplaceTags.join('|')})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`, 'g');
		let noReplaceMatch;
		while ((noReplaceMatch = noReplaceRegex.exec(text)) !== null) {
			const contentIndex = noReplaceMatch.index + noReplaceMatch[0].indexOf(noReplaceMatch[2]);
			const contentEndIndex = contentIndex + noReplaceMatch[2].length;
			noReplaceRanges.push({ start: contentIndex, end: contentEndIndex });
		}

		// Find XML comments and add them to the ignore ranges.
		const commentRegex = /<!--[\s\S]*?-->/g;
		let commentMatch;
		while ((commentMatch = commentRegex.exec(text)) !== null) {
			// Add the entire comment block to the no-replace ranges.
			noReplaceRanges.push({ start: commentMatch.index, end: commentMatch.index + commentMatch[0].length });
		}

		// 2. Find content inside double quotes.
		const quoteRegex = /"([^"]+)"/g;
		let quoteMatch;
		while ((quoteMatch = quoteRegex.exec(text)) !== null) {
			const valueStartIndex = quoteMatch.index + 1;
			noReplaceRanges.push({ start: valueStartIndex, end: valueStartIndex + quoteMatch[1].length });
		}

		// 2. Find content of attributes that should not be replaced (e.g., xml:id, linkend).
		const attrRegex = /="([^"]+)"/g;
		let attrMatch;
		while ((attrMatch = attrRegex.exec(text)) !== null) {
			// The attribute value is in group 1. We need to calculate its start and end index within the document.
			// The start index of the value is the index of the full match plus the length of the attribute name part (e.g., 'linkend="').
			const valueStartIndex = attrMatch.index + attrMatch[0].indexOf(attrMatch[1]);
			const valueEndIndex = valueStartIndex + attrMatch[1].length;
			noReplaceRanges.push({ start: valueStartIndex, end: valueEndIndex });
		}

		if (noReplaceRanges.length > 0) {
			dbg(`Found ${noReplaceRanges.length} no-replace zones.`);
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

		// Convert the map to an array and sort it by the length of the entity value in descending order.
		// This ensures that longer, more specific phrases (including multiline ones) are matched first.
		const sortedEntities = Array.from(entityValueMap.entries()).sort((a, b) => b[0].length - a[0].length);

		sortedEntities.forEach(([entityValue, entityName]) => {
			// Escape special characters in the entity value for use in a regular expression.
			// Then, replace spaces with `\s+` to match any whitespace sequence (including newlines) and wrap with word boundaries.
			const pattern = `\\b(${entityValue
				.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') // Escape regex special characters.
				.replace(/\s+/g, '\\s+')})\\b`;
			const regex = new RegExp(pattern, 'gi');
			let match;

			// Check if the entity value itself is in the ignore list.
			// Using `some` to allow for case-insensitive comparison if needed in the future.
			if (ignorePhrases.some(phrase => phrase.toLowerCase() === entityValue.toLowerCase())) {
				return; // Skip this entity entirely.
			}

			while ((match = regex.exec(text)) !== null) {
				// Check if the match is already part of an entity reference (e.g., `&cockpit;`).
				const charBefore = text.charAt(match.index - 1);
				const charAfter = text.charAt(match.index + match[0].length);
				if (charBefore === '&' && charAfter === ';') {
					continue; // Skip this match as it's already an entity.
				}

				// Check if the match is part of a compound phrase (e.g., "nvidia-custom-string", "containers/ollama").
				// We check for a non-whitespace character followed by a separator, or a separator followed by a non-whitespace character.
				const beforeStr = text.substring(match.index - 2, match.index);
				const afterStr = text.substring(match.index + match[0].length, match.index + match[0].length + 2);
				const isCompound = /\S[-+./]$/.test(beforeStr) || /^[-+./]\S/.test(afterStr);

				if (isCompound) {
					continue; // Skip this match as it's part of a compound phrase.
				}

				// Check if the match is inside one of the no-replace tag ranges.
				const inNoReplaceZone = noReplaceRanges.some(zone =>
					match.index >= zone.start && (match.index + match[0].length) <= zone.end
				);
				if (inNoReplaceZone) {
					continue; // Skip this match.
				}
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
						`Consider replacing with an entity (${entityName.length} options)`,
						vscode.DiagnosticSeverity.Warning
					);
					diagnostic.code = 'replaceWithEntity';
					diagnostic.source = 'DAPS';
					diagnostics.push(diagnostic);
					// Add the range to our list of diagnosed ranges to prevent overlaps.
					diagnosedRanges.push(range);
					// Store all possible replacements in the diagnostic object itself for the CodeActionProvider to use.
					diagnostic.relatedInformation = entityName.map(name => new vscode.DiagnosticRelatedInformation(new vscode.Location(document.uri, range), name));
				}
			}
		});

		// Apply the collected diagnostics to the document.
		entityDiagnostics.set(document.uri, diagnostics);
	}

	/**
	 * Analyzes an AsciiDoc document for strings that can be replaced by an AsciiDoc attribute and creates diagnostics.
	 * @param {vscode.TextDocument} document The document to analyze.
	 */
	function updateAttributeDiagnostics(document) {
		const dapsConfig = vscode.workspace.getConfiguration('daps');
		const replaceWithADOCattribute = dapsConfig.get('replaceWithADOCattribute');
		if (!replaceWithADOCattribute || document.languageId !== 'asciidoc') {
			attributeDiagnostics.clear();
			return;
		}

		const noReplaceBlocks = dapsConfig.get('replaceWithADOCattributeIgnoreBlocks');
		const noReplaceRanges = [];
		const ignorePhrases = dapsConfig.get('replaceWithIgnorePhrases');
		const text = document.getText();

		// 1. Find content of no-replace blocks (e.g., source, literal).
		// This regex finds both styled blocks like `[source]` and simple delimited blocks `----`.
		// It also finds command prompts ($) that might be part of a command block.
		const blockRegex = new RegExp(`^\\[(${noReplaceBlocks.join('|')})\\]\\n((?:.*\\\\\\n)*.*[^\\\\]\\n)`, 'gm');
		let noReplaceMatch;

		while ((noReplaceMatch = blockRegex.exec(text)) !== null) {
			noReplaceRanges.push({ start: noReplaceMatch.index, end: noReplaceMatch.index + noReplaceMatch[0].length });
		}

		// 2. Find content of inline monospace/literal text (e.g., `text` or ``text``).
		// This regex finds text enclosed in single or double backticks.
		const inlineMonoRegex = /(`{1,2})([^`]+?)\1/g;
		let inlineMatch;
		while ((inlineMatch = inlineMonoRegex.exec(text)) !== null) {
			const contentIndex = inlineMatch.index;
			noReplaceRanges.push({ start: contentIndex, end: contentIndex + inlineMatch[0].length });
		}

		// 3. Find AsciiDoc comments (single-line and block).
		const singleLineCommentRegex = /^\/\/.*/gm;
		let commentMatch;
		while ((commentMatch = singleLineCommentRegex.exec(text)) !== null) {
			noReplaceRanges.push({ start: commentMatch.index, end: commentMatch.index + commentMatch[0].length });
		}
		const blockCommentRegex = /^\/{4,}\n[\s\S]*?\n\/{4,}$/gm;
		while ((commentMatch = blockCommentRegex.exec(text)) !== null) {
			noReplaceRanges.push({ start: commentMatch.index, end: commentMatch.index + commentMatch[0].length });
		}

		// 4. Find AsciiDoc section IDs and anchors (e.g., [[my-id]] or [#my-id]).
		const sectionIdRegex = /\[\[[^\]]+\]\]|\[#[^\]]+\]/g;
		let idMatch;
		while ((idMatch = sectionIdRegex.exec(text)) !== null) {
			noReplaceRanges.push({ start: idMatch.index, end: idMatch.index + idMatch[0].length });
		}

		// 5. Find AsciiDoc cross-references (e.g., <<my-anchor>>).
		const xrefRegex = /<<[^>]+>>/g;
		let xrefMatch;
		while ((xrefMatch = xrefRegex.exec(text)) !== null) {
			noReplaceRanges.push({ start: xrefMatch.index, end: xrefMatch.index + xrefMatch[0].length });
		}

		// 6. Find content inside double quotes.
		const quoteRegex = /"([^"]+)"/g;
		let quoteMatch;
		while ((quoteMatch = quoteRegex.exec(text)) !== null) {
			const valueStartIndex = quoteMatch.index + 1;
			noReplaceRanges.push({ start: valueStartIndex, end: valueStartIndex + quoteMatch[1].length });
		}

		// 6. Find URLs and other network schemas (e.g., https://..., ftp://..., mailto:...).
		const urlRegex = /\b(https?|ftp|file|mailto|irc|news|telnet):\/\/[^\s,>\])]+/g;
		let urlMatch;
		while ((urlMatch = urlRegex.exec(text)) !== null) {
			noReplaceRanges.push({ start: urlMatch.index, end: urlMatch.index + urlMatch[0].length });
		}


		if (noReplaceRanges.length > 0) {
			dbg(`Found ${noReplaceRanges.length} no-replace AsciiDoc blocks.`);
		}

		const attributeValueMap = getADOCattributes(document.fileName);
		if (attributeValueMap.size === 0) {
			attributeDiagnostics.clear();
			return;
		}

		const diagnostics = [];
		const diagnosedRanges = [];

		const sortedAttributes = Array.from(attributeValueMap.entries()).sort((a, b) => b[0].length - a[0].length);

		sortedAttributes.forEach(([attrValue, attrName]) => {
			// Ensure the value is not empty and is substantial enough to avoid trivial matches.
			if (attrValue.trim().length < 2) return;

			const pattern = `\\b(${attrValue
				.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
				.replace(/\s+/g, '\\s+')})\\b`;
			const regex = new RegExp(pattern, 'gi');
			let match;

			if (ignorePhrases.some(phrase => phrase.toLowerCase() === attrValue.toLowerCase())) {
				return; // Skip this attribute entirely.
			}

			while ((match = regex.exec(text)) !== null) {
				// Check if the match is already part of an attribute reference (e.g., {sliberty}).
				const charBefore = text.charAt(match.index - 1);
				const charAfter = text.charAt(match.index + match[0].length);
				if (charBefore === '{' && charAfter === '}') {
					continue;
				}

				// Check if the match is part of a compound phrase (e.g., "nvidia-custom-string", "containers/ollama").
				// We check for a non-whitespace character followed by a separator, or a separator followed by a non-whitespace character.
				const beforeStr = text.substring(match.index - 2, match.index);
				const afterStr = text.substring(match.index + match[0].length, match.index + match[0].length + 2);
				const isCompound = /\S[-+./]$/.test(beforeStr) || /^[-+./]\S/.test(afterStr);

				if (isCompound) {
					continue; // Skip this match as it's part of a compound phrase.
				}

				// Check if the match is inside one of the no-replace block ranges.
				const inNoReplaceZone = noReplaceRanges.some(zone =>
					match.index >= zone.start && (match.index + match[0].length) <= zone.end
				);
				if (inNoReplaceZone) {
					continue;
				}

				const startPos = document.positionAt(match.index);
				const endPos = document.positionAt(match.index + match[0].length);
				const range = new vscode.Range(startPos, endPos);

				const isOverlapping = diagnosedRanges.some(diagnosedRange => range.intersection(diagnosedRange));

				if (!isOverlapping) {
					let diagnostic = new vscode.Diagnostic(
						range,
						`Consider replacing with an attribute (${attrName.length} options)`,
						vscode.DiagnosticSeverity.Warning
					);
					diagnostic.relatedInformation = attrName.map(name => new vscode.DiagnosticRelatedInformation(new vscode.Location(document.uri, range), `{${name.slice(1, -1)}}`));
					diagnostic.code = 'replaceWithAttribute';
					diagnostic.source = 'DAPS'; // The replacement text is stored in the message
					diagnostics.push(diagnostic);
					diagnosedRanges.push(range);
				}
			}
		});

		attributeDiagnostics.set(document.uri, diagnostics);
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
						// The possible replacements are stored in relatedInformation.
						if (diagnostic.relatedInformation) {
							diagnostic.relatedInformation.forEach(info => {
								const replacementText = info.message; // e.g., "&k8s;"
								const action = new vscode.CodeAction(`Replace with ${replacementText}`, vscode.CodeActionKind.QuickFix);
								action.edit = new vscode.WorkspaceEdit();
								action.edit.replace(document.uri, diagnostic.range, replacementText);
								action.diagnostics = [diagnostic];
								codeActions.push(action);
							});
						}
					});
				return codeActions;
			}
		})
	);
	/**
	 * Registers a Code Actions Provider for AsciiDoc files to offer a "Quick Fix" for attribute diagnostics.
	 */
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider('asciidoc', {
			provideCodeActions(document, range, context, token) {
				const codeActions = [];
				context.diagnostics
					.filter(diagnostic => diagnostic.code === 'replaceWithAttribute')
					.forEach(diagnostic => {
						if (diagnostic.relatedInformation) {
							diagnostic.relatedInformation.forEach(info => {
								const replacementText = info.message; // e.g., "{k8s}"
								const action = new vscode.CodeAction(`Replace with ${replacementText}`, vscode.CodeActionKind.QuickFix);
								action.edit = new vscode.WorkspaceEdit();
								action.edit.replace(document.uri, diagnostic.range, replacementText);
								action.diagnostics = [diagnostic];
								codeActions.push(action);
							});
						}
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
			const dapsConfig = vscode.workspace.getConfiguration('daps'); // This is fine as it's within the command handler

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
		const dapsConfig = vscode.workspace.getConfiguration('daps'); // This is fine as it's within the command handler
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
		pattern: vscode.workspace.getConfiguration('daps').get('dbAssemblyPattern')
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
	if (vscode.workspace.getConfiguration('daps').get('autocompleteXMLentities')) {
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
		const dapsConfig = vscode.workspace.getConfiguration('daps'); // This is fine as it's within the command handler
		// path to images
		let docPreviewImgPath = dapsConfig.get('docPreviewImgPath');
		dbg(`preview:docPreviewImgPath ${docPreviewImgPath}`);
		const activeEditorDir = getActiveEditorDir();
		dbg(`preview:activeEditorDir ${activeEditorDir}`);
		// create a new webView if it does not exist yet
		if (previewManager.panel === undefined) {
			previewManager.panel = vscode.window.createWebviewPanel(
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
			const imgWebviewUri = previewManager.panel.webview.asWebviewUri(imgUri);
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

		previewManager.panel.webview.html = html;
		previewManager.panel.webview.postMessage({ command: 'updateMap', map: scrollMap });
		previewManager.panel.onDidDispose(() => {
			previewManager.dispose();
		});

		// listen to scroll messages from the active editor
		vscode.window.onDidChangeTextEditorVisibleRanges(event => {
			const editor = event.textEditor;
			const topLine = editor.visibleRanges[0].start.line;
			previewManager.panel.webview.postMessage({ command: 'syncScroll', line: topLine });
		});
		// Listen to scroll messages from the WebView
		let previewLinkScrollBoth = vscode.workspace.getConfiguration('daps').get('previewLinkScrollBoth');
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
		if (!vscode.workspace.workspaceFolders) {
			vscode.window.showErrorMessage("Cannot run DAPS command: No workspace folder is open.");
			return false;
		}
		const workspaceFolderUri = vscode.workspace.workspaceFolders[0].uri;
		var DCfile = await getDCfile(contextDCfile);
		if (DCfile) {
			const dapsCmd = getDapsCmd({ DCfile: DCfile, cmd: 'validate' });
			const success = await executeDapsCommand(dapsCmd, 'Validation succeeded.');
			if (success) {
				return true;
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
		if (!vscode.workspace.workspaceFolders) {
			vscode.window.showErrorMessage("Cannot run DAPS command: No workspace folder is open.");
			return false;
		}
		const workspaceFolderUri = vscode.workspace.workspaceFolders[0].uri;
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
			try {
				// change working directory to current workspace
				process.chdir(workspaceFolderUri.path);
				dbg(`cwd is ${workspaceFolderUri.path}`);
				if (dapsConfig.get('runTerminal')) {
					const terminal = getDapsTerminal();
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
			const dapsConfig = vscode.workspace.getConfiguration('daps'); // This is fine as it's within the command handler
			try {
				await autoSave(XMLfile);
				if (dapsConfig.get('runTerminal')) {
					const terminal = getDapsTerminal();
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
		if (!vscode.workspace.workspaceFolders) {
			vscode.window.showErrorMessage("Cannot run DAPS command: No workspace folder is open.");
			return;
		}
		const workspaceFolderUri = vscode.workspace.workspaceFolders[0].uri;
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
			const success = await executeDapsCommand(dapsCmd, 'Build succeeded.', async (cmdOutput) => {
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
			});
			return success;
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
			const dapsConfig = vscode.workspace.getConfiguration('daps'); // This is fine as it's within the command handler
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
		if (!vscode.workspace.workspaceFolders) {
			vscode.window.showErrorMessage("Cannot get Root ID: No workspace folder is open.");
			return;
		}
		const workspaceFolderUri = vscode.workspace.workspaceFolders[0].uri;
		var rootId;
		const dapsConfig = vscode.workspace.getConfiguration('daps'); // This is fine as it's within the command handler
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
		if (!vscode.workspace.workspaceFolders) {
			vscode.window.showErrorMessage("Cannot get Root IDs: No workspace folder is open.");
			return [];
		}
		const workspaceFolderUri = vscode.workspace.workspaceFolders[0].uri;
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
		const dapsConfig = vscode.workspace.getConfiguration('daps'); // This is fine as it's within the command handler
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
	if (!folderUri) {
		// If no folder is open, we can't get DC files.
		if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
			folderUri = vscode.workspace.workspaceFolders[0].uri;
		} else return [];
	}
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
	if (!vscode.workspace.workspaceFolders) {
		vscode.window.showErrorMessage("Cannot get DC file: No workspace folder is open.");
		return;
	}
	const workspaceFolderUri = vscode.workspace.workspaceFolders[0].uri;
	var DCfile;
	const dapsConfig = vscode.workspace.getConfiguration('daps'); // This is fine as it's within the command handler
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
	const dapsConfig = vscode.workspace.getConfiguration('daps'); // This is fine as it's within the command handler
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
 * @description Scans an AsciiDoc file for included attribute files recursively.
 * @param {string} docFileName - The path to the AsciiDoc file to start scanning from.
 * @param {Set<string>} [processedFiles=new Set()] - A set of already processed file paths to avoid circular includes.
 * @returns {string[]} An array of absolute paths to the included attribute files.
 */
function getADOCattributeFiles(docFileName, processedFiles = new Set()) {
	// Check if this is the first (non-recursive) call by seeing if the processedFiles set is empty.
	const initialCall = processedFiles.size === 0;
	// If it's the initial call,
	if (initialCall) {
		// add the main document to the set of processed files to prevent it from being included in the results if referenced within other files.
		processedFiles.add(docFileName);
	}

	// Check if a document file name was provided and if the file exists.
	if (!docFileName || !fs.existsSync(docFileName)) {
		// Log a debug message if the file is missing or not specified.
		dbg(`getADOCattributeFiles: File does not exist or is not provided: ${docFileName}`);
		// Return an empty array as no files can be processed.
		return [];
	}

	// Log which file is currently being processed.
	dbg(`getADOCattributeFiles: Processing ${docFileName}`);

	// Read the content of the AsciiDoc file.
	const docContent = fs.readFileSync(docFileName, 'utf-8');
	// Get the directory of the current file to resolve relative paths.
	const docDir = path.dirname(docFileName);
	// Define a regular expression to find 'include::filename.adoc[]' statements at the beginning of a line.
	const includeRegex = /^include::([^\[]+)\[\]/gm;
	// Initialize an array to store the paths of found attribute files.
	let attributeFiles = [];
	// Variable to hold the result of the regex execution.
	let match;

	// Loop through all 'include::' matches in the document content.
	while ((match = includeRegex.exec(docContent)) !== null) {
		// Extract the relative path from the regex match (the first captured group).
		const relativePath = match[1];
		// Resolve the relative path to an absolute path based on the current document's directory.
		const absolutePath = path.resolve(docDir, relativePath);

		// Check if this file has already been processed to prevent infinite loops from circular includes.
		if (processedFiles.has(absolutePath)) {
			// Log that a circular dependency was detected and skip this file.
			dbg(`getADOCattributeFiles: Circular include detected, skipping ${absolutePath}`);
			// Continue to the next match.
			continue;
		}

		// Add the new absolute path to the set of processed files.
		processedFiles.add(absolutePath);
		// Add the absolute path to our list of attribute files.
		attributeFiles.push(absolutePath);
		// Recursively call this function for the newly found file to process its includes, and concatenate the results.
		attributeFiles = attributeFiles.concat(getADOCattributeFiles(absolutePath, processedFiles));
	}
	// Return the final list of all collected attribute file paths.
	return attributeFiles;
}

/**
 * @description Parses AsciiDoc attribute files to create a map of resolved attribute values to their names.
 * This function handles nested attributes (e.g., :attr1: {attr2}) by recursively resolving them.
 * @param {string} docFileName - The path to the main AsciiDoc document.
 * @returns {Map<string, string>} A map from resolved attribute values to attribute names (e.g., "SUSE Liberty Linux" -> ":sliberty:").
 */
function getADOCattributes(docFileName) {
	// 1. Get all attribute files, including nested includes.
	const attributeFiles = getADOCattributeFiles(docFileName);
	// Also include the current document in the list of files to scan for attributes.
	attributeFiles.unshift(docFileName);

	// This map will store the initial name-to-value mapping, e.g., 'sliberty' -> '{suse} Liberty Linux'.
	const nameToValueMap = new Map();

	// --- First pass: Collect all raw attribute definitions from all files. ---
	attributeFiles.forEach(attrFile => {
		try {
			const fileContent = fs.readFileSync(attrFile, 'utf8');
			// Regex to capture an attribute's name and its value.
			// Example: :my-attribute: Some value here
			const attributeRegex = /^:([^:]+):\s+(.*)$/gm;
			let match;

			while ((match = attributeRegex.exec(fileContent)) !== null) {
				const [, attrName, attrValue] = match;
				// Store the raw attribute definition.
				const cleanedValue = attrValue.trim().replace(/{nbsp}/g, ' ');
				nameToValueMap.set(attrName.trim(), cleanedValue);
			}
		} catch (error) {
			dbg(`Error reading or parsing AsciiDoc attribute file ${attrFile}: ${error.message}`);
		}
	});

	// --- Second pass: Resolve nested attributes and create the final value-to-name map. ---
	// This map will store the final, fully resolved value to its attribute name, e.g., 'SUSE Liberty Linux' -> ':sliberty:'.
	const attributeValueMap = new Map();
	// Regex to find attribute references (e.g., {attr-name}) within a string.
	const nestedAttrRegex = /\{([a-zA-Z0-9_.-]+)\}/g;

	for (const [attrName, attrValue] of nameToValueMap.entries()) {
		let resolvedValue = attrValue;
		let match;
		// Use a Set to track attributes seen during the resolution of a single value to detect circular references.
		const seen = new Set();

		// Keep replacing nested attributes until no more can be found or a circular dependency is detected.
		while ((match = nestedAttrRegex.exec(resolvedValue)) !== null) {
			const nestedAttrName = match[1];

			// Check for circular references.
			if (seen.has(nestedAttrName)) {
				dbg(`Circular attribute reference detected for '{${nestedAttrName}}' in ':${attrName}:'. Skipping further resolution.`);
				break; // Avoid infinite loop.
			}
			seen.add(nestedAttrName);

			// If the nested attribute exists in our map, replace it with its value.
			if (nameToValueMap.has(nestedAttrName)) {
				resolvedValue = resolvedValue.replace(match[0], nameToValueMap.get(nestedAttrName));
				// Reset regex index to re-scan the modified string from the beginning.
				nestedAttrRegex.lastIndex = 0;
			}
		}

		// Store the fully resolved value and its corresponding attribute name in the final map.
		// The key is the value, and the value is the attribute name formatted for replacement.
		const formattedAttrName = `:${attrName}:`;
		if (attributeValueMap.has(resolvedValue)) {
			// If this value already exists, add the new attribute name to the array.
			attributeValueMap.get(resolvedValue).push(formattedAttrName);
		} else {
			// Otherwise, create a new entry with an array containing this attribute name.
			attributeValueMap.set(resolvedValue, [formattedAttrName]);
		}
	}

	dbg(`getADOCattributes: Found ${attributeValueMap.size} resolved AsciiDoc attributes.`);
	return attributeValueMap;
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

	// Also include the current document in the list of files to scan for entities.
	entityFiles.push(documentFileName);

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
		let match, lastResolvedValue;
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
			const nestedValue = nameToValueMap.get(nestedEntityName);
			if (nestedValue !== undefined) {
				lastResolvedValue = resolvedValue;
				resolvedValue = resolvedValue.replace(match[0], nestedValue);
				entityRegex.lastIndex = 0; // Reset regex index to re-scan the modified string
				if (resolvedValue === lastResolvedValue) {
					dbg(`Resolution stalled for '${entityName}'. Breaking to prevent infinite loop.`);
					break;
				}
			}
		}

		// Store the fully resolved value and its corresponding entity name in the final map.
		const formattedEntityName = `&${entityName};`;
		if (entityValueMap.has(resolvedValue)) {
			// If this value already exists, add the new entity name to the array.
			entityValueMap.get(resolvedValue).push(formattedEntityName);
		} else {
			// Otherwise, create a new entry with an array containing this entity name.
			entityValueMap.set(resolvedValue, [formattedEntityName]);
		}
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
