import fs from 'fs';
import path from 'path';
import type { Content } from 'mdast';
import { createDocFromState, DocxSerializer, writeDocx } from 'myst-to-docx';
import type { ValidationOptions } from 'simple-validators';
import type { Export } from 'myst-frontmatter';
import { validateExport, ExportFormats } from 'myst-frontmatter';
import { VFile } from 'vfile';
import type { ISession } from '../../session/types';
import { getRawFrontmatterFromFile } from '../../store/local/actions';
import { createTempFolder, findProjectAndLoad, writeFileToFolder } from '../../utils';
import type { ExportWithOutput } from '../types';
import { getDefaultExportFilename, getDefaultExportFolder } from '../utils/defaultNames';
import { resolveAndLogErrors } from '../utils/resolveAndLogErrors';
import { cleanOutput } from '../utils/cleanOutput';
import { getFileContent } from '../utils/getFileContent';
import { createArticleTitle } from './titles';
import { selectAll } from 'mystjs';

export type WordExportOptions = {
  filename: string;
  clean?: boolean;
};

export async function collectWordExportOptions(
  session: ISession,
  file: string,
  extension: string,
  formats: ExportFormats[],
  projectPath: string | undefined,
  opts: WordExportOptions,
) {
  const { filename } = opts;
  const rawFrontmatter = await getRawFrontmatterFromFile(session, file);
  const exportErrorMessages: ValidationOptions['messages'] = {};
  let exportOptions: Export[] =
    rawFrontmatter?.exports
      ?.map((exp: any, ind: number) => {
        return validateExport(exp, {
          property: `exports.${ind}`,
          messages: exportErrorMessages,
        });
      })
      .filter((exp: Export | undefined) => exp && formats.includes(exp?.format)) || [];
  // If any arguments are provided on the CLI, only do a single export using the first available frontmatter docx options
  if (filename) {
    if (exportOptions.length) {
      exportOptions = [exportOptions[0]];
    } else if (formats.length) {
      exportOptions = [{ format: formats[0] }];
    } else {
      exportOptions = [];
    }
  }
  const resolvedExportOptions: ExportWithOutput[] = exportOptions
    .map((exp): ExportWithOutput | undefined => {
      let output: string;
      if (filename) {
        output = filename;
      } else if (exp.output) {
        // output path from file frontmatter needs resolution relative to working directory
        output = path.resolve(path.dirname(file), exp.output);
      } else {
        output = getDefaultExportFolder(session, file, projectPath);
      }
      if (!path.extname(output)) {
        const slug = getDefaultExportFilename(session, file, projectPath);
        output = path.join(output, `${slug}.${extension}`);
      }
      if (!output.endsWith(`.${extension}`)) {
        session.log.error(`The filename must end with '.${extension}': "${output}"`);
        return undefined;
      }
      return { ...exp, output };
    })
    .filter((exp): exp is ExportWithOutput => Boolean(exp))
    .map((exp, ind, arr) => {
      // Make identical export output values unique
      const nMatch = (a: ExportWithOutput[]) => a.filter((e) => e.output === exp.output).length;
      if (nMatch(arr) === 1) return { ...exp };
      const { dir, name, ext } = path.parse(exp.output);
      return {
        ...exp,
        output: path.join(dir, `${name}_${nMatch(arr.slice(0, ind))}${ext}`),
      };
    });
  if (exportOptions.length === 0) {
    throw new Error(
      `No export options of format ${formats.join(', ')} defined in frontmatter of ${file}${
        exportErrorMessages.errors?.length
          ? '\nPossible causes:\n- ' + exportErrorMessages.errors.map((e) => e.message).join('\n- ')
          : ''
      }`,
    );
  }
  resolvedExportOptions.forEach((exp) => {
    session.log.info(`🔍 Performing export: ${exp.output}`);
  });
  return resolvedExportOptions;
}

export async function runWordExport(
  session: ISession,
  file: string,
  exportOptions: ExportWithOutput,
  projectPath?: string,
  clean?: boolean,
) {
  const { output } = exportOptions;
  if (clean) cleanOutput(session, output);
  const { mdast, frontmatter, references } = await getFileContent(
    session,
    file,
    createTempFolder(),
    projectPath,
  );
  const frontmatterNodes = createArticleTitle(frontmatter.title, frontmatter.authors) as Content[];
  const vfile = new VFile();
  const serializer = new DocxSerializer(vfile, {
    getImageBuffer(image: string) {
      return fs.readFileSync(image).buffer as any;
    },
    useFieldsForCrossReferences: true,
  });
  frontmatterNodes.forEach((node) => {
    serializer.render(node);
  });
  serializer.renderChildren(mdast);
  Object.values(references.footnotes).forEach((footnote) => {
    serializer.render(footnote);
  });
  const doc = createDocFromState(serializer);
  session.log.info(`🖋  Writing docx to ${output}`);
  writeDocx(doc, (buffer) => writeFileToFolder(output, buffer));
}

export async function localArticleToWord(session: ISession, file: string, opts: WordExportOptions) {
  const projectPath = await findProjectAndLoad(session, path.dirname(file));
  const exportOptionsList = await collectWordExportOptions(
    session,
    file,
    'docx',
    [ExportFormats.docx],
    projectPath,
    opts,
  );
  await resolveAndLogErrors(
    session,
    exportOptionsList.map(async (exportOptions) => {
      await runWordExport(session, file, exportOptions, projectPath, opts.clean);
    }),
  );
}
