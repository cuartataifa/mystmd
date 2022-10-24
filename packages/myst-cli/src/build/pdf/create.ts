import fs from 'fs';
import path from 'path';
import util from 'util';
import JTex, { pdfExportCommand } from 'jtex';
import { exec } from 'myst-cli-utils';
import type { ISession } from '../../session/types';
import { createTempFolder } from '../../utils';
import type { ExportWithOutput } from '../types';
import { cleanOutput } from '../utils/cleanOutput';

const copyFile = util.promisify(fs.copyFile);

function copyContents(srcFolder: string, destFolder: string) {
  fs.readdirSync(srcFolder).forEach((item) => {
    const srcItemPath = path.join(srcFolder, item);
    const destItemPath = path.join(destFolder, item);
    if (fs.lstatSync(srcItemPath).isDirectory()) {
      fs.mkdirSync(destItemPath);
      copyContents(srcItemPath, destItemPath);
    } else {
      fs.copyFileSync(srcItemPath, destItemPath);
    }
  });
}

export async function createPdfGivenTexExport(
  session: ISession,
  texExportOptions: ExportWithOutput,
  pdfOutput: string,
  copyLogs?: boolean,
  clean?: boolean,
  templateRootDir?: string,
) {
  if (clean) cleanOutput(session, pdfOutput);
  const { output: texOutput, template } = texExportOptions;

  const buildPath = createTempFolder();
  const texFile = path.basename(texOutput);
  const texBuild = path.join(buildPath, texFile);
  copyContents(path.dirname(texOutput), buildPath);

  if (!fs.existsSync(texBuild)) {
    session.log.error(`Could not find tex file: ${texOutput}`);
    throw Error(`pdf export failed`);
  }

  const pdfBasename = path.basename(pdfOutput, path.extname(pdfOutput));
  const pdfFile = `${pdfBasename}.pdf`;
  const pdfBuild = path.join(buildPath, pdfFile);

  const logFile = `${pdfBasename}.log`;
  const texLogFile = `${pdfBasename}.shell.log`;
  // Temporary log file locations
  const logBuild = path.join(buildPath, logFile);
  const texLogBuild = path.join(buildPath, texLogFile);
  // Log file location saved alongside pdf
  const logOutputFolder = path.join(path.dirname(pdfOutput), `${pdfBasename}_pdf_logs`);
  const logOutput = path.join(logOutputFolder, logFile);
  const texLogOutput = path.join(logOutputFolder, texLogFile);
  if (clean) cleanOutput(session, logOutputFolder);

  let buildCommand: string;
  if (!template) {
    buildCommand = pdfExportCommand(texFile, texLogFile);
  } else {
    const jtex = new JTex(session, { template: template || undefined, rootDir: templateRootDir });
    buildCommand = jtex.pdfExportCommand(texFile, texLogFile);
  }
  try {
    session.log.info(`🖨  Rendering pdf to ${pdfBuild}`);
    session.log.debug(`Running command:\n> ${buildCommand}`);
    await exec(buildCommand, { cwd: buildPath });
    session.log.debug(`Done building LaTeX.`);
  } catch (err) {
    session.log.error(
      `Error while invoking mklatex - logs available at: ${
        copyLogs ? logOutputFolder : buildPath
      }\n${err}`,
    );
  }

  const pdfBuildExists = fs.existsSync(pdfBuild);
  const logBuildExists = fs.existsSync(logBuild);
  const texLogBuildExists = fs.existsSync(texLogBuild);

  if (pdfBuildExists && !fs.existsSync(path.dirname(pdfOutput))) {
    fs.mkdirSync(path.dirname(pdfOutput), { recursive: true });
  }

  if (pdfBuildExists) {
    session.log.info(`🧬 Copying pdf to ${pdfOutput}`);
    await copyFile(pdfBuild, pdfOutput);
    session.log.debug(`Copied PDF file to ${pdfOutput}`);
  } else {
    session.log.error(`Could not find ${pdfBuild} as expected`);
  }
  if (copyLogs) {
    if ((logBuildExists || texLogBuildExists) && !fs.existsSync(path.dirname(logOutput))) {
      fs.mkdirSync(path.dirname(logOutput), { recursive: true });
    }
    if (logBuildExists) {
      session.log.debug(`Copying log file: ${logOutput}`);
      await copyFile(logBuild, logOutput);
    }

    if (texLogBuildExists) {
      session.log.debug(`Copying log file: ${texLogOutput}`);
      await copyFile(texLogBuild, texLogOutput);
    }
  }
  if (!fs.existsSync(pdfOutput)) {
    throw Error(`pdf export failed`);
  }
}
