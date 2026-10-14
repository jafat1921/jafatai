import { useId, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ApiTokenCreated } from '@/lib/types'
import { Card } from './SystemChecks'

const PLACEHOLDER = '<your-token>'

function mcpSnippets(origin: string, token: string) {
  const url = `${origin}/api/mcp`
  // mcp-remote bridges Desktop's stdio config to an HTTP server; the header lives in env so Windows
  // doesn't split "Bearer <token>" into two arguments
  const desktop = {
    mcpServers: {
      mixai: {
        command: 'npx',
        args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${MIXAI_AUTH}'],
        env: { MIXAI_AUTH: `Bearer ${token}` },
      },
    },
  }
  return {
    url,
    code: `claude mcp add --transport http mixai ${url} --header "Authorization: Bearer ${token}"`,
    desktop: JSON.stringify(desktop, null, 2),
  }
}

function Snippet({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard blocked on plain http: the block is selectable, so Ctrl+C still works
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <pre
        tabIndex={0}
        aria-label={label}
        className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-[6px] border border-studio-border bg-studio-raised p-3 font-mono text-small"
      >
        {text}
      </pre>
      <Button size="sm" variant="secondary" className="self-start" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </Button>
    </div>
  )
}

/** Copy-paste setup for Claude Code, Claude Desktop and other MCP clients. Never shows a real token unless the
 * user ticks the box for the one they made just now (it's only in memory on this page). */
export function ConnectClaudeCard({ fresh }: { fresh: ApiTokenCreated | null }) {
  const uid = useId()
  const [fill, setFill] = useState(false)
  const token = fill && fresh ? fresh.token : PLACEHOLDER
  const s = mcpSnippets(window.location.origin, token)

  return (
    <Card title="Connect to Claude">
      <p className="text-body text-studio-muted">
        Claude can use the studio as tools: make pictures, video, music and voices, build characters, and fetch the
        results. It acts with a token's scopes, so make one with <strong className="font-medium text-studio-text">Read</strong>{' '}
        and <strong className="font-medium text-studio-text">Generate</strong> for it.
      </p>
      {fresh && (
        <label className="flex items-start gap-2.5 text-body">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-studio-accent"
            checked={fill}
            onChange={(e) => setFill(e.target.checked)}
            aria-describedby={`${uid}-fill`}
          />
          <span>
            Fill in “{fresh.name}”, the token you just made
            <span id={`${uid}-fill`} className="block text-small text-studio-muted">
              Only on this page, until you leave it. Otherwise paste your token where it says {PLACEHOLDER}.
            </span>
          </span>
        </label>
      )}
      <Tabs defaultValue="code" className="flex flex-col gap-3">
        <TabsList aria-label="MCP client" className="flex-wrap">
          <TabsTrigger value="code">Claude Code</TabsTrigger>
          <TabsTrigger value="desktop">Claude Desktop</TabsTrigger>
          <TabsTrigger value="other">Other clients</TabsTrigger>
        </TabsList>
        <TabsContent value="code" className="flex flex-col gap-2">
          <p className="text-small text-studio-muted">Run this once in a terminal, then ask Claude to use mixai.</p>
          <Snippet label="Claude Code command" text={s.code} />
        </TabsContent>
        <TabsContent value="desktop" className="flex flex-col gap-2">
          <p className="text-small text-studio-muted">
            Settings → Developer → Edit config, add this to <code className="font-mono">claude_desktop_config.json</code>,
            then restart Claude Desktop. Needs Node.js for <code className="font-mono">npx</code>.
          </p>
          <Snippet label="Claude Desktop config" text={s.desktop} />
        </TabsContent>
        <TabsContent value="other" className="flex flex-col gap-2">
          <p className="text-small text-studio-muted">
            Any MCP client that speaks Streamable HTTP can connect to this address. Send the token as a header on every
            request: <code className="font-mono">Authorization: Bearer {PLACEHOLDER}</code>.
          </p>
          <Snippet label="MCP server URL" text={s.url} />
        </TabsContent>
      </Tabs>
      <p className="text-small text-studio-muted">
        If the studio uses a self-signed certificate, Node-based clients refuse it until the certificate is trusted on
        that computer (or, for testing only, <code className="font-mono">NODE_TLS_REJECT_UNAUTHORIZED=0</code> is set).
      </p>
    </Card>
  )
}
