import { connect as netConnect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import type { Client, ClientChannel } from 'ssh2'
import type { ForwardState, PortForward } from '../../shared/types'

/**
 * Port forwarding over one SSH connection:
 *  - local   (-L): listen here, connect from the server to destHost:destPort
 *  - remote  (-R): the server listens, connections come back to destHost:destPort reachable from here
 *  - dynamic (-D): a SOCKS5 proxy here; every request is opened from the server
 */

interface Runtime {
  state: ForwardState
  server?: Server
  /** remote forwards: the address/port the server bound */
  remoteBind?: { address: string; port: number }
  sockets: Set<Socket>
}

function pipeBoth(a: Socket, b: ClientChannel): void {
  a.pipe(b).pipe(a)
  const end = (): void => {
    a.destroy()
    b.destroy()
  }
  a.on('error', end).on('close', end)
  b.on('error', end).on('close', end)
}

export class ForwardManager {
  private runtimes = new Map<string, Runtime>()
  private tcpHandlerInstalled = false

  constructor(
    private client: Client,
    private onChange: (states: ForwardState[]) => void
  ) {}

  list(): ForwardState[] {
    return [...this.runtimes.values()].map((r) => ({ ...r.state }))
  }

  private changed(): void {
    this.onChange(this.list())
  }

  private openFromServer(src: Socket, host: string, port: number): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      this.client.forwardOut(src.remoteAddress ?? '127.0.0.1', src.remotePort ?? 0, host, port, (err, ch) => (err ? reject(err) : resolve(ch)))
    })
  }

  async start(fwd: PortForward): Promise<ForwardState> {
    this.stop(fwd.id)
    const rt: Runtime = { state: { id: fwd.id, forward: fwd, status: 'starting', connections: 0 }, sockets: new Set() }
    this.runtimes.set(fwd.id, rt)
    this.changed()
    try {
      if (fwd.type === 'remote') await this.startRemote(rt)
      else await this.startListener(rt)
      rt.state.status = 'active'
    } catch (e) {
      rt.state.status = 'error'
      rt.state.error = friendly(e as NodeJS.ErrnoException, fwd)
      rt.server?.close()
    }
    this.changed()
    return { ...rt.state }
  }

  stop(id: string): void {
    const rt = this.runtimes.get(id)
    if (!rt) return
    this.runtimes.delete(id)
    rt.server?.close()
    for (const s of rt.sockets) s.destroy()
    if (rt.remoteBind) this.client.unforwardIn(rt.remoteBind.address, rt.remoteBind.port, () => undefined)
    this.changed()
  }

  stopAll(): void {
    for (const id of [...this.runtimes.keys()]) this.stop(id)
  }

  private track(rt: Runtime, sock: Socket): void {
    rt.sockets.add(sock)
    rt.state.connections = rt.sockets.size
    this.changed()
    sock.on('close', () => {
      rt.sockets.delete(sock)
      rt.state.connections = rt.sockets.size
      if (this.runtimes.get(rt.state.id) === rt) this.changed()
    })
  }

  // ----- local & dynamic: a listener on this machine -----

  private startListener(rt: Runtime): Promise<void> {
    const fwd = rt.state.forward
    const server = createServer((sock) => {
      this.track(rt, sock)
      sock.on('error', () => sock.destroy())
      if (fwd.type === 'local') {
        sock.pause()
        this.openFromServer(sock, fwd.destHost, fwd.destPort).then(
          (ch) => {
            pipeBoth(sock, ch)
            sock.resume()
          },
          () => sock.destroy()
        )
      } else {
        this.socks5(sock)
      }
    })
    rt.server = server
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(fwd.bindPort, fwd.bindAddress || '127.0.0.1', () => {
        server.off('error', reject)
        server.on('error', () => undefined)
        rt.state.boundPort = (server.address() as AddressInfo).port
        resolve()
      })
    })
  }

  /** Minimal SOCKS5 (RFC 1928): no authentication, CONNECT only; names are resolved on the server. */
  private socks5(sock: Socket): void {
    let buf = Buffer.alloc(0)
    let stage: 'greeting' | 'request' | 'done' = 'greeting'
    const fail = (code: number): void => {
      sock.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]))
      stage = 'done'
    }
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      if (stage === 'greeting') {
        if (buf.length < 2) return
        const n = buf[1]
        if (buf[0] !== 5) return void sock.destroy()
        if (buf.length < 2 + n) return
        const methods = buf.subarray(2, 2 + n)
        buf = buf.subarray(2 + n)
        if (!methods.includes(0)) {
          sock.end(Buffer.from([5, 0xff]))
          stage = 'done'
          return
        }
        sock.write(Buffer.from([5, 0]))
        stage = 'request'
      }
      if (stage === 'request') {
        if (buf.length < 5) return
        const [ver, cmd, , atyp] = buf
        if (ver !== 5) return void sock.destroy()
        let host: string
        let off: number
        if (atyp === 1) {
          if (buf.length < 10) return
          host = [...buf.subarray(4, 8)].join('.')
          off = 8
        } else if (atyp === 3) {
          const len = buf[4]
          if (buf.length < 5 + len + 2) return
          host = buf.subarray(5, 5 + len).toString('utf8')
          off = 5 + len
        } else if (atyp === 4) {
          if (buf.length < 22) return
          const b = buf.subarray(4, 20)
          host = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(':')
          off = 20
        } else {
          return fail(8) // address type not supported
        }
        const port = buf.readUInt16BE(off)
        const rest = buf.subarray(off + 2)
        stage = 'done'
        sock.off('data', onData)
        if (cmd !== 1) return fail(7) // command not supported
        sock.pause()
        this.openFromServer(sock, host, port).then(
          (ch) => {
            sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
            if (rest.length) ch.write(rest)
            pipeBoth(sock, ch)
            sock.resume()
          },
          (err: Error) => fail(/refused/i.test(err.message) ? 5 : /unreachable|resolve|not known/i.test(err.message) ? 4 : 1)
        )
      }
    }
    sock.on('data', onData)
  }

  // ----- remote: the server listens -----

  private installTcpHandler(): void {
    if (this.tcpHandlerInstalled) return
    this.tcpHandlerInstalled = true
    this.client.on('tcp connection', (info, accept, reject) => {
      const rt = [...this.runtimes.values()].find(
        (r) => r.remoteBind && r.remoteBind.port === info.destPort && r.state.status === 'active'
      )
      if (!rt) return reject()
      const fwd = rt.state.forward
      const local = netConnect({ host: fwd.destHost || '127.0.0.1', port: fwd.destPort })
      local.once('connect', () => {
        const ch = accept()
        this.track(rt, local)
        pipeBoth(local, ch)
      })
      local.once('error', () => {
        reject()
        local.destroy()
      })
    })
  }

  private startRemote(rt: Runtime): Promise<void> {
    const fwd = rt.state.forward
    this.installTcpHandler()
    const address = fwd.bindAddress || '127.0.0.1'
    return new Promise((resolve, reject) => {
      this.client.forwardIn(address, fwd.bindPort, (err, port) => {
        if (err) return reject(err)
        const bound = fwd.bindPort || port
        rt.remoteBind = { address, port: bound }
        rt.state.boundPort = bound
        resolve()
      })
    })
  }
}

function friendly(e: NodeJS.ErrnoException, fwd: PortForward): string {
  if (e.code === 'EADDRINUSE') return `Port ${fwd.bindPort} is already in use on this computer`
  if (e.code === 'EACCES') return `Not allowed to listen on port ${fwd.bindPort} (ports below 1024 need admin rights)`
  if (e.code === 'EADDRNOTAVAIL') return `${fwd.bindAddress} is not an address of this computer`
  if (fwd.type === 'remote' && /request failed|prohibited/i.test(e.message)) {
    return `The server refused to listen on ${fwd.bindAddress || '127.0.0.1'}:${fwd.bindPort} (port in use, or AllowTcpForwarding/GatewayPorts disabled)`
  }
  return e.message
}
