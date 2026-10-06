import type { FileChild, ILevelsOptions, IParagraphOptions, IRunOptions, ParagraphChild } from "docx";
import type { Token, Tokens } from "marked";
import { countImageTags, decodeEntities, isSafeLink, stripInvalidXmlChars } from "./markdown";

type Docx = typeof import("docx");

const MONO_FONT = "Consolas";
const CODE_FILL = "F2F2F2";
/** Twips (1/20 pt): one list or quote level, and the text width of A4 with the default 1in margins. */
const INDENT_STEP = 720;
const CONTENT_WIDTH = 9026;
const MAX_LIST_LEVEL = 8;

interface InlineStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
}

interface BlockContext {
  /** Left indent the surrounding lists and quotes add. */
  indent: number;
  quote: boolean;
}

/** Builds the body of a Word document from marked's tokens. */
class DocxBuilder {
  omittedImages = 0;
  readonly numbering: Array<{ reference: string; levels: ILevelsOptions[] }> = [];

  constructor(private readonly docx: Docx) {}

  private run(text: string, style: InlineStyle, extra: Partial<IRunOptions> = {}) {
    return new this.docx.TextRun({
      text: stripInvalidXmlChars(text),
      bold: style.bold,
      italics: style.italics,
      strike: style.strike,
      ...(style.code ? { font: MONO_FONT, shading: { type: this.docx.ShadingType.CLEAR, fill: CODE_FILL } } : {}),
      ...(style.link ? { style: "Hyperlink" } : {}),
      ...extra,
    });
  }

  inline(tokens: Token[] | undefined, style: InlineStyle = {}): ParagraphChild[] {
    const out: ParagraphChild[] = [];
    for (const token of tokens ?? []) {
      switch (token.type) {
        case "text": {
          const nested = (token as Tokens.Text).tokens;
          if (nested?.length) out.push(...this.inline(nested, style));
          else out.push(this.run(decodeEntities(token.text), style));
          break;
        }
        case "escape":
          out.push(this.run(token.text, style));
          break;
        case "strong":
          out.push(...this.inline(token.tokens, { ...style, bold: true }));
          break;
        case "em":
          out.push(...this.inline(token.tokens, { ...style, italics: true }));
          break;
        case "del":
          out.push(...this.inline(token.tokens, { ...style, strike: true }));
          break;
        case "codespan":
          out.push(this.run(token.text, { ...style, code: true }));
          break;
        case "br":
          out.push(this.run("", style, { break: 1 }));
          break;
        case "link":
          if (isSafeLink(token.href) && !style.link) {
            const children = this.inline(token.tokens, { ...style, link: true });
            out.push(new this.docx.ExternalHyperlink({ link: token.href.trim(), children }));
          } else {
            out.push(...this.inline(token.tokens, style));
          }
          break;
        case "image":
          // Never fetched or embedded: the alt text stands in for it.
          this.omittedImages++;
          out.push(this.run(`[${token.text || "image"}]`, style));
          break;
        case "html":
          this.omittedImages += countImageTags(token.raw);
          out.push(this.run(token.raw, style));
          break;
        case "checkbox":
          out.push(this.run(token.checked ? "☒ " : "☐ ", style));
          break;
        default:
          if ("tokens" in token && token.tokens) out.push(...this.inline(token.tokens, style));
          else if (token.raw) out.push(this.run(token.raw, style));
      }
    }
    return out;
  }

  private paragraph(children: ParagraphChild[], context: BlockContext, options: Partial<IParagraphOptions> = {}) {
    const { BorderStyle } = this.docx;
    return new this.docx.Paragraph({
      children,
      spacing: { after: 160 },
      ...(context.indent ? { indent: { left: context.indent } } : {}),
      ...(context.quote ? { border: { left: { style: BorderStyle.SINGLE, size: 12, color: "BBBBBB", space: 8 } } } : {}),
      ...options,
    });
  }

  /** Text on several lines in one paragraph, e.g. a code block. */
  private lines(text: string, style: InlineStyle, extra: Partial<IRunOptions> = {}): ParagraphChild[] {
    return text.split(/\r?\n/).map((line, index) => this.run(line, style, index > 0 ? { ...extra, break: 1 } : extra));
  }

  blocks(tokens: Token[], context: BlockContext = { indent: 0, quote: false }): FileChild[] {
    const { BorderStyle, HeadingLevel, ShadingType } = this.docx;
    const headings = [
      HeadingLevel.HEADING_1,
      HeadingLevel.HEADING_2,
      HeadingLevel.HEADING_3,
      HeadingLevel.HEADING_4,
      HeadingLevel.HEADING_5,
      HeadingLevel.HEADING_6,
    ];
    const out: FileChild[] = [];
    for (const token of tokens) {
      switch (token.type) {
        case "space":
        case "def":
          break;
        case "heading":
          out.push(
            this.paragraph(this.inline(token.tokens), context, {
              heading: headings[Math.min(Math.max(token.depth, 1), 6) - 1],
              spacing: { before: 240, after: 120 },
            }),
          );
          break;
        case "paragraph":
          out.push(this.paragraph(this.inline(token.tokens), context));
          break;
        case "text":
          out.push(this.paragraph(this.inline([token]), context));
          break;
        case "code":
          out.push(
            this.paragraph(this.lines(token.text, {}, { font: MONO_FONT, size: 19 }), context, {
              shading: { type: ShadingType.CLEAR, fill: CODE_FILL },
              spacing: { before: 160, after: 160 },
              keepLines: true,
            }),
          );
          break;
        case "blockquote":
          out.push(...this.blocks(token.tokens ?? [], { indent: context.indent + INDENT_STEP, quote: true }));
          break;
        case "hr":
          out.push(
            this.paragraph([], context, {
              border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } },
            }),
          );
          break;
        case "list":
          out.push(...this.list(token as Tokens.List, context, 0));
          break;
        case "table":
          out.push(this.table(token as Tokens.Table));
          break;
        case "html":
          this.omittedImages += countImageTags(token.raw);
          out.push(this.paragraph(this.lines(token.raw.replace(/\n+$/, ""), {}), context));
          break;
        default:
          if ("tokens" in token && token.tokens) out.push(this.paragraph(this.inline(token.tokens), context));
          else if (token.raw.trim()) out.push(this.paragraph(this.lines(token.raw.trim(), {}), context));
      }
    }
    return out;
  }

  /** A numbering definition of its own for each ordered list, so every list starts at its own number. */
  private orderedReference(start: number): string {
    const { AlignmentType, LevelFormat } = this.docx;
    const reference = `ordered-${this.numbering.length + 1}`;
    const levels: ILevelsOptions[] = [];
    for (let level = 0; level <= MAX_LIST_LEVEL; level++) {
      levels.push({ level, format: LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.LEFT, start });
    }
    this.numbering.push({ reference, levels });
    return reference;
  }

  private list(list: Tokens.List, context: BlockContext, depth: number): FileChild[] {
    const level = Math.min(depth, MAX_LIST_LEVEL);
    const start = typeof list.start === "number" && list.start >= 0 ? list.start : 1;
    const reference = list.ordered ? this.orderedReference(start) : "";
    const textIndent = context.indent + INDENT_STEP * (level + 1);
    const marker: Partial<IParagraphOptions> = {
      ...(list.ordered ? { numbering: { reference, level } } : { bullet: { level } }),
      indent: { left: textIndent, hanging: 360 },
      spacing: { after: 80 },
    };

    const out: FileChild[] = [];
    for (const item of list.items) {
      let lead: ParagraphChild[] = [];
      let marked = false;
      const emitMarker = () => {
        out.push(this.paragraph(lead, context, marker));
        lead = [];
        marked = true;
      };
      for (const block of item.tokens) {
        if (block.type === "space") continue;
        if (block.type === "checkbox") {
          lead.push(...this.inline([block]));
        } else if (!marked && (block.type === "text" || block.type === "paragraph")) {
          lead.push(...this.inline(block.type === "text" ? [block] : block.tokens));
          emitMarker();
        } else {
          // The bullet or number always comes first, even when the item opens with a code block.
          if (!marked) emitMarker();
          if (block.type === "list") out.push(...this.list(block as Tokens.List, context, depth + 1));
          else out.push(...this.blocks([block], { ...context, indent: textIndent }));
        }
      }
      if (!marked) emitMarker();
    }
    return out;
  }

  private table(table: Tokens.Table): FileChild {
    const { AlignmentType, Paragraph, ShadingType, Table, TableCell, TableRow, WidthType } = this.docx;
    const columns = Math.max(table.header.length, 1);
    const columnWidth = Math.floor(CONTENT_WIDTH / columns);
    const alignment = (align: Tokens.TableCell["align"]) =>
      align === "center" ? AlignmentType.CENTER : align === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT;
    const cell = (source: Tokens.TableCell, header: boolean) =>
      new TableCell({
        width: { size: columnWidth, type: WidthType.DXA },
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        ...(header ? { shading: { type: ShadingType.CLEAR, fill: "EDEDED" } } : {}),
        children: [new Paragraph({ children: this.inline(source.tokens, header ? { bold: true } : {}), alignment: alignment(source.align) })],
      });
    return new Table({
      width: { size: columnWidth * columns, type: WidthType.DXA },
      columnWidths: Array.from({ length: columns }, () => columnWidth),
      rows: [
        new TableRow({ tableHeader: true, cantSplit: true, children: table.header.map(source => cell(source, true)) }),
        ...table.rows.map(row => new TableRow({ cantSplit: true, children: row.map(source => cell(source, false)) })),
      ],
    });
  }
}

/**
 * Writes markdown as a Word document. Images are not fetched or embedded (their alt text is kept
 * in brackets and they are counted), and raw HTML is written as literal text.
 */
export async function markdownToDocxBuffer(markdown: string, title?: string): Promise<{ buffer: Buffer; omittedImages: number }> {
  const [docx, { Marked }] = await Promise.all([import("docx"), import("marked")]);
  const tokens = new Marked({ gfm: true }).lexer(markdown);
  const builder = new DocxBuilder(docx);
  const children = builder.blocks(tokens);
  // A table may not be the last thing in the body, and an empty body is not a valid document.
  if (children.length === 0 || children.at(-1) instanceof docx.Table) children.push(new docx.Paragraph({}));

  const document = new docx.Document({
    title,
    numbering: { config: builder.numbering },
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ children }],
  });
  return { buffer: await docx.Packer.toBuffer(document), omittedImages: builder.omittedImages };
}
