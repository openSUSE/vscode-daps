# Change Log

## 0.7.10
- introduced peek view for DocBook assemblies

## 0.7.9
- fixed CodeLens for <module>'s with no resourceRef
- changed dbgChannel name to DAPS

## 0.7.8
- fixed event for trigerring doc structure treeview refresh

## 0.7.7
- introduced `daps.enableDbg` option to choose between console and output
  channel messages
- updated `node_modules`
- fixed looped refreshing of doc structure window

## 0.7.6
- included `node_modules` directory when building package

## 0.7.5
- fixed call for non-obsolete domxml that failed extension activation

## 0.7.3
- small tweaks for cmd registration

## 0.7.2
- fixed paths of executables and config files to work across distributions

## 0.7.1
- fixed document structure treeview for elements with missing title

## 0.7.0
- document structure treeview works on multiple tags
- fixed CodeLens for all DocBook XML assembly files
- xmldom library now bundled with the extension

## 0.6.2
- added document structure treeview for sections
- improved CodeLens for DocBook assemblies by parsing XML

## 0.6.1
- introduced own WebView HTML preview
- dependency on 'Document Preview' extension is no more

## 0.6.0
- added CodeLens capability to DocBook assembly files

## 0.5.2
- fixed XML entity autocompletion with empty exclude option


## 0.5.1
- improved XML entity autocompletion filtering by typing

## 0.5.0
- auto-completion XML entites from external files
- added `daps.autocompleteXMLentities` option to enable entity auto-completion
- added `daps.excludeXMLentityFiles` option to exclude specific entity files
  from autocompletion

## 0.4.4
- removed `--styleroot`` option from the `daps validate` command
- added `daps.runTerminal` option to show `daps` cmd output
- added `daps.verbosityLevel` option to adjust debug info in terminal

## 0.4.3
- made document preview work for ANY repo, no tmp file needed

## 0.4.2
- fixed document preview for non-modular repos

## 0.4.1
- disabled static images

## 0.4.0
- added support for document privew

## 0.3.0
- added support for --styleroot
- added support for --dapsroot
- added dapsExecutable option

## 0.2.2
- removed status messages for XML formatting

## 0.2.1
- --single build option only for HTML targets, not PDF

## 0.2.0
- added option to auto-save XML file before running dpa scommand on it
- fixed XML format, now works for dirty editors from contextuals
- added direct building of XML file without DC file

## 0.1.0
- added support for root IDs
- added Explorer context validation
- added Explorer context build
- added Editor tab XML format

## 0.0.2
- code cleanup

## 0.0.1
- initial release
