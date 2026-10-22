# DAPS extension for VSCode

The SUSE Documentation Team <doc-team@suse.com>

A VSCode extension that makes use of DAPS (https://github.com/openSUSE/daps) to validate and build documents.

> [!TIP]
> The complete documentation is available at https://opensuse.github.io/vscode-daps.
>
> It can be displayed from the installed extension as well, open the command palette (`F1` or
> `Ctrl+Shift+P`) and run the `DAPS: Extension Help` command.

`vscode-daps` is released under the GPL (version 2 or 3 at your choice).

## Installation

For this extension to work, meet the following requirements:

* Install the `daps` binary
* Install the VSCode extension either from the `Extensions` panel of VSCode, or manually:

  ```bash
  code --install-extension openSUSE.daps
  ```

## Reporting Bugs

To report bugs, use the bug tracker of this repository: https://github.com/openSUSE/vscode-daps/issues.

## Contributing

If you would like to contribute to the project, do the following:

1. Fork this project.

2. Clone the project:
   ```bash
   git clone git@github.com:YOUR_USERNAME/vscode-daps.git
   ```

3. Create a new branch from the main branch.
   ```bash
   git branch <BRANCH_NAME> main
   ```

4. Make your changes.

5. To build the extension and run it locally press `F5` key.

6. To build the extension package locally (to inspect its conetent) run `npx vsce package`.

7. Send a pull request.
