'use strict';
/* tslint:disable:no-console */
import * as path from 'path';
import { URL } from 'url';
import sane = require('sane');
import Koa from 'koa';
import route from 'koa-route';
import koaStatic from 'koa-static';
import koaWebsocket = require('koa-websocket');
import koaMount from 'koa-mount';
import * as WebSocket from 'ws';
import { generateProxyMiddleware, Transpiler } from './generateProxyMiddleware';
import { hmrEntryMiddleware } from './hmrEntryMiddleware';
import { Message, MessageType } from './message';

const clientBase = path.resolve(__dirname, '..', 'client');

export interface ServerOptions {
    port: number;
    host: string;
    directory: string;
    transpiler?: Transpiler;
    pathResolver?: (path: string) => string | Promise<string>;
    wsMessageHandler?: (message: any) => void;
}

export class Server {
    private sockets: Set<WebSocket>;
    app: koaWebsocket.App;
    private options: ServerOptions;
    private rootURL: URL;

    constructor(options: ServerOptions) {
        this.sockets = new Set();
        this.options = options;
        this.rootURL = new URL(getURLString('http', options));
        this.app = koaWebsocket(new Koa());
    }

    async start() {
        this.setupHmrMiddleware();
        this.setupAppMiddleware();

        await this.app.listen(this.options.port, this.options.host);
        console.log(`Server started on ${this.rootURL}`);
        const watcher = sane(this.options.directory);
        watcher.on('change', (filepath, root, stat) => {
            console.log(`File changed ${filepath}`);
            this.broadcast({
                type: MessageType.CHANGE,
                url: this.fileUrl(filepath),
                mtime: stat.mtimeMs
            });
        });
    }

    private setupHmrMiddleware() {
        this.app.use(
            route.get(
                '/@hmr/api',
                hmrEntryMiddleware({
                    websocketURL: `${getURLString('ws', this.options)}/@hmr/socket`,
                    filePath: path.join(clientBase, 'api.js')
                })
            )
        );
        this.app.ws.use(
            route.all('/@hmr/socket', context => {
                const websocket = (context as koaWebsocket.MiddlewareContext).websocket;
                this.addConnection(websocket);
            })
        );
        this.app.use(koaMount('/@hmr', koaStatic(clientBase, { extensions: ['.js'] })));
    }

    private setupAppMiddleware() {
        this.app.use(
            generateProxyMiddleware({
                rootPath: this.options.directory,
                transpiler: this.options.transpiler,
                pathResolver: this.options.pathResolver
            })
        );
        this.app.use(koaStatic(this.options.directory));
    }

    private fileUrl(filepath: string): string {
        return new URL(filepath, this.rootURL).href;
    }

    private addConnection(websocket: WebSocket) {
        this.sockets.add(websocket);
        websocket.on('close', () => {
            console.log('socket disconnected');
            this.sockets.delete(websocket);
        });
        if (this.options.wsMessageHandler) {
            websocket.on('message', this.options.wsMessageHandler);
        }
    }

    broadcast(message: Message) {
        const stringified = JSON.stringify(message);
        for (const socket of this.sockets) {
            socket.send(stringified);
        }
    }
}

function getURLString(protocol: string, options: ServerOptions) {
    return `${protocol}://${options.host}:${options.port}`;
}
