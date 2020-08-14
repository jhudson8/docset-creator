import createSqlWasm from "sql-wasm";
import { join, normalize, basename } from "path";
import fs, { existsSync, copy, ensureDirSync } from "fs-extra";
// the following doesn't have a type definition
const recursiveCopy = require("recursive-copy");
import { rmdir } from "./util";
import {
  DocsetEntryType,
  normalizePath,
  mergeEntries,
  MainOptions,
} from "docset-tools-types";

export default async function (options: MainOptions, argv: any): Promise<void> {
  const {
    iconsPath,
    docsPath,
    isJavascriptEnabled,
    docsetPlatformFamily,
    fallbackUrl,
    plugins,
  } = options;
  let {
    docsetIdentifier,
    outputPath,
    indexFileName,
    indexFileDirPath,
  } = options;
  let entries = options.entries || {};
  let indexFilePath;

  if (!docsetIdentifier) {
    docsetIdentifier = require(join(process.cwd(), "package.json")).name;
  }
  outputPath = outputPath ? normalizePath(outputPath) : process.cwd();

  const docsetFileName = docsetIdentifier + ".docset";
  const outputBasePath = join(outputPath, docsetFileName);
  const outputContentsPath = join(outputBasePath, "Contents");
  const outputResourcesPath = join(outputContentsPath, "Resources");
  const outputDocsPath = join(outputResourcesPath, "Documents");
  const docsetName = options.docsetName || docsetIdentifier;
  const dryRun = argv["dry-run"];

  await rmdir(outputBasePath);
  await rmdir(outputBasePath + ".tgz");

  const log = (...args: any[]) => {
    if (options.logToConsole) {
      console.log(...args);
    }
  };

  let tmpCount = 0;
  const plistAdditions: Record<string, string[]> = {};
  const parentTmpPath = join(process.cwd(), "._docset_tmp");
  const createTmpFolder = async (): Promise<string> => {
    tmpCount++;
    const path = join(parentTmpPath, tmpCount.toString());
    return path;
  };

  const include = async ({
    path,
    rootDirName,
  }: {
    path: string;
    rootDirName?: string;
  }) => {
    // copy the content to the output directory
    if (!dryRun) {
      const destPath = rootDirName
        ? join(outputDocsPath, rootDirName)
        : outputDocsPath;
      await recursiveCopy(path, destPath);
    }
  };

  const _options = {
    ...options,
    dryRun,
  };
  try {
    for (let i = 0; i < plugins.length; i++) {
      const plugin = plugins[i];
      const data = await plugin.plugin.execute({
        cliArgs: argv,
        createTmpFolder,
        include,
        pluginOptions: plugin.options || {},
        mainOptions: _options,
        workingDir: process.cwd(),
      });
      if (entries.index) {
        if (!indexFileName && (plugin.useAsIndex || plugins.length === 1)) {
          indexFileName = basename(entries.index);
          indexFileDirPath = entries.index.replace(
            /[\\\/]?[^\\\/]+[\\\/]?[^\\\/]?$/,
            ""
          );
        }
      }
      entries = mergeEntries(entries, data.entries);
      if (data.plist) {
        Object.entries(data.plist).forEach(([key, value]) => {
          if (!plistAdditions[key]) {
            plistAdditions[key] = [];
          }
          plistAdditions[key].push(value);
        });
      }
    }

    if (!indexFileName && !options.hasOwnProperty("indexFileName")) {
      indexFileName = "index.html";
    }
    const indexFilePath = normalize(
      options.indexFileDirPath
        ? join(options.indexFileDirPath, indexFileName)
        : indexFileName
    ).replace(/\\/g, "/");

    if (docsPath) {
      const fullDocsPath = normalizePath(docsPath);
      log("copying from " + fullDocsPath + " to " + outputDocsPath);
      await recursiveCopy(fullDocsPath, outputDocsPath);
    }

    log("creating index");
    const wasmPath = require.resolve("sql-wasm/dist/sqlite3.wasm");
    const SQL = await createSqlWasm({ wasmUrl: wasmPath });
    const db = new SQL.Database();
    const commands = [
      `CREATE TABLE searchIndex(id INTEGER PRIMARY KEY, name TEXT, type TEXT, path TEXT);`,
      `CREATE UNIQUE INDEX anchor ON searchIndex (name, type, path);`,
    ];

    const fileRefs: {
      type: DocsetEntryType;
      path: string;
      name: string;
    }[] = [];
    Object.entries(entries).forEach(([type, entries]) => {
      function normalizePath(path: any) {
        let _path = (path as any) as string;
        _path = _path.replace(/[\\/]#/, "#").replace(/\\/g, "/");
        if (_path.endsWith("/")) {
          _path = _path + indexFileName;
        }
        if (!_path.match(/^\.?\//) && options.indexFileDirPath) {
          _path = normalize(join(options.indexFileDirPath, _path));
        }
        if (_path.startsWith("/")) {
          _path = _path.replace(/^\//, "");
        }
        _path = _path.replace(/\\/g, "/");
        return _path;
      }

      if (type === "index") {
        const _path = normalizePath(entries);
        fileRefs.push({ type: null, path: _path, name: "index" });
      } else {
        Object.entries(entries).forEach(([name, path]) => {
          const _path = normalizePath(path);
          fileRefs.push({ type: type as DocsetEntryType, path: _path, name });
          commands.push(
            `INSERT OR IGNORE INTO searchIndex(name, type, path) VALUES ('${escape(
              name
            )}', '${escape(type)}', '${escape(_path)}');`
          );
        });
      }
    });

    for (let i = 0; i < commands.length; i++) {
      await db.exec(commands[i]);
    }

    // save to file
    const data = db.export();
    const buffer = Buffer.from(data);
    ensureDirSync(outputResourcesPath);
    await fs.writeFile(join(outputResourcesPath, "docSet.dsidx"), buffer);

    // create info.plist
    log("creating info.plist");
    const infoPlistData = `
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
        <key>CFBundleIdentifier</key>
        <string>${docsetIdentifier}</string>
        <key>CFBundleName</key>
        <string>${docsetName}</string>
        <key>DocSetPlatformFamily</key>
        <string>${docsetPlatformFamily}</string>
        <key>isDashDocset</key>
        <true/>
        <key>dashIndexFilePath</key>
        <string>${indexFilePath}</string>
        <key>isJavaScriptEnabled</key><${
          isJavascriptEnabled ? "true" : "false"
        }/>${
      fallbackUrl
        ? `
        <key>DashDocSetFallbackURL</key>
        <string>${fallbackUrl}</string>`
        : ""
    }${Object.entries(plistAdditions).map(
      ([key, entries]) => `
        <key>${key}</key>${entries.map(
        (value) => `
        <string>${value
          .replace(/&/g, "&amp")
          .replace(/</g, "&lt")
          .replace(/>/g, "&gt")}</string>`
      )}
        `
    )}
      </dict>
      </plist>
`;
    await fs.writeFile(join(outputContentsPath, "info.plist"), infoPlistData);

    // icons
    if (iconsPath) {
      log("copying icons...");
      const iconPath = join(iconsPath, "icon.png");
      const iconExists = existsSync(iconPath);
      if (iconExists) {
        await copy(iconPath, join(outputBasePath, "icon.png"));
      } else {
        console.error(iconPath + " does not exist");
      }
      const icon2xPath = join(iconsPath, "icon@2x.png");
      const icon2xExists = existsSync(iconPath);
      if (icon2xExists) {
        await copy(icon2xPath, join(outputBasePath, "icon@2x.png"));
      } else {
        console.error(icon2xPath + " does not exist");
      }
    }

    fileRefs.forEach(({ type, name, path }) => {
      if (path.startsWith("#")) {
        path = indexFilePath ? indexFilePath + path : path;
      }
      // make sure the file is valid
      path = normalize(join(outputDocsPath, path));
      console.log(path);
      const pathToCheck = path.replace(/#.*/, "");
      if (!fs.existsSync(pathToCheck)) {
        throw new Error(`${path} not found`);
      }
      path = "file://" + encodeURI(path.replace(/\\/g, "/"));
      if (type) {
        console.log(type + " > " + name + "\n\t" + path);
      } else {
        console.log("[" + name + "]\n\t" + path);
      }
    });
  } finally {
    try {
      await rmdir(parentTmpPath);
    } catch (e) {
      console.error(e);
    }
  }
}