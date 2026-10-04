// Scripts are kept flush-left. Text pasted from PDFs / Final Draft arrives with
// screenplay indentation (centred character cues, indented dialogue) - drop it.
// \s covers tabs, nbsp and the unicode space block, which PDF copies love.
export function flushLeft(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^\s+/, '').replace(/\s+$/, ''))
    .join('\n')
}
