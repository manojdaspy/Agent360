# MCP Server Testing Guide

## Overview

This document explains how to manually test an MCP (Model Context Protocol) SSE server using PowerShell and curl.

Example MCP SSE endpoint:

```txt
https://studentassignment.lyralogics.com/mcp/sse
```

---

# 1. Verify SSE Connection

Open an SSE stream using curl.

## PowerShell

```powershell
curl.exe -N -H "Accept: text/event-stream" "https://studentassignment.lyralogics.com/mcp/sse"
```

Expected output:

```txt
event: endpoint
data: /mcp/messages/?session_id=xxxxxxxx

: ping - 2026-06-10 ...
```

This confirms:

* SSE transport is active
* MCP session initialized
* Keepalive ping working

---

# 2. Copy Session ID

From the SSE response:

```txt
data: /mcp/messages/?session_id=64903eac379749f595cf826d2dc99b67
```

Session ID:

```txt
64903eac379749f595cf826d2dc99b67
```

All future requests use this session ID.

---

# 3. Initialize MCP Session

Run this in a second PowerShell terminal.

```powershell
$body = @{
    jsonrpc = "2.0"
    id = 1
    method = "initialize"
    params = @{
        protocolVersion = "2024-11-05"
        capabilities = @{}
        clientInfo = @{
            name = "powershell-test"
            version = "1.0"
        }
    }
} | ConvertTo-Json -Depth 10 -Compress

Invoke-RestMethod `
    -Method POST `
    -Uri "https://studentassignment.lyralogics.com/mcp/messages/?session_id=SESSION_ID" `
    -ContentType "application/json" `
    -Body $body
```

Expected result:

```txt
Accepted
```

SSE terminal should show:

```txt
event: message
data: {...initialize response...}
```

---

# 4. List Available Tools

```powershell
$body = @{
    jsonrpc = "2.0"
    id = 2
    method = "tools/list"
} | ConvertTo-Json -Compress

Invoke-RestMethod `
    -Method POST `
    -Uri "https://studentassignment.lyralogics.com/mcp/messages/?session_id=SESSION_ID" `
    -ContentType "application/json" `
    -Body $body
```

Expected SSE output:

```json
{
  "result": {
    "tools": [...]
  }
}
```

---

# 5. Call a Tool

## Example: Read File

```powershell
$body = @{
    jsonrpc = "2.0"
    id = 3
    method = "tools/call"
    params = @{
        name = "cat"
        arguments = @{
            path = "README.md"
        }
    }
} | ConvertTo-Json -Depth 10 -Compress

Invoke-RestMethod `
    -Method POST `
    -Uri "https://studentassignment.lyralogics.com/mcp/messages/?session_id=SESSION_ID" `
    -ContentType "application/json" `
    -Body $body
```

Expected SSE result:

```json
{
  "result": {
    "content": [...]
  }
}
```

---

# 6. Create File Example

```powershell
$body = @{
    jsonrpc = "2.0"
    id = 4
    method = "tools/call"
    params = @{
        name = "write"
        arguments = @{
            path = "hello.txt"
            content = "Hello from MCP"
        }
    }
} | ConvertTo-Json -Depth 10 -Compress

Invoke-RestMethod `
    -Method POST `
    -Uri "https://studentassignment.lyralogics.com/mcp/messages/?session_id=SESSION_ID" `
    -ContentType "application/json" `
    -Body $body
```

---

# 7. Common Issues

## PowerShell curl Problem

PowerShell aliases `curl` to `Invoke-WebRequest`.

Use:

```powershell
curl.exe
```

instead of:

```powershell
curl
```

---

## Invalid JSON Errors

Wrong:

```txt
{jsonrpc:2.0,id:1}
```

Correct:

```json
{"jsonrpc":"2.0","id":1}
```

Use `ConvertTo-Json` to avoid escaping issues.

---

# 8. MCP Flow Architecture

```txt
User
  ↓
Agent Runtime
  ↓
LLM
  ↓
MCP Client
  ↓
MCP Server
  ↓
Filesystem / Shell / Git / Tools
```

The LLM does reasoning only.

The MCP runtime performs actual execution.

---

# 9. Useful MCP Methods

## Initialize

```txt
initialize
```

## List Tools

```txt
tools/list
```

## Call Tool

```txt
tools/call
```

## List Resources

```txt
resources/list
```

## Read Resource

```txt
resources/read
```

---

# 10. Recommended Tools

## MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

## mcp-remote

```bash
npx mcp-remote https://studentassignment.lyralogics.com/mcp/sse
```

---

# Testing Complete

If all steps work:

* SSE transport works
* Session management works
* JSON-RPC works
* MCP tools work
* Agent integration ready

Your MCP server is operational.
