import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

/** Extract plain text from a PDF or DOCX. Structuring happens in a later step (LLM). */
export async function extractResumeText(path: string): Promise<string> {
  const ext = extname(path).toLowerCase()
  const buf = await readFile(path)
  if (ext === '.pdf') {
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: new Uint8Array(buf) })
    try { return (await parser.getText()).text } finally { await parser.destroy() }
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth')
    return (await mammoth.extractRawText({ buffer: buf })).value
  }
  throw new Error(`Unsupported resume type: ${ext}`)
}
