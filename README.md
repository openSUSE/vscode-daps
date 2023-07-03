# daps-vscode README

## Features

The DAPS tool helps you author and publish documentation written in DocBook XML.
This extension makes it easier to run selected DAPS commands from the VSCode
editor.

## Requirements

This extension requires that you install DAPS on your system. Refer to
(https://opensuse.github.io/daps/) for more details.

## Usage

The following sections illustrate how to use the `vscode-daps` extension to run
DAPS commands.

### Validate XML documents

You can validate a document specified by its DC file. Right click the DC file in
the Explorer view and select `Daps` -> `Validate`.
![Validating from explorer](https://github.com/openSUSE/vscode-daps/blob/3572f9d76b371ee7d15398637156551c03f8fef6/media/daps-validate-explorer-context.webm)

Or, you can specify the DC file manually from a drop down list. Verify that the
Explorer shows a documentation project, then press `CTRL`+`SHIFT`+P to open a
command palette. Start to type `DAPS` and select the `Build with DC file`
command. Then select the desired DC file and build format from the populated
drop down lists.
![Validate from command palette](https://github.com/openSUSE/vscode-daps/blob/419337d218c8608a241f57fbb631322e01048d07/media/daps-validate-palette.webm)



## Known Issues

See our issue tracker at
[openSUSE/vscode-daps/issues](https://github.com/openSUSE/vscode-daps/issues)
