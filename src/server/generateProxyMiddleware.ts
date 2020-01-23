import fs from 'fs-extra';
import * as path from 'path';
import send from 'koa-send';
import { Middleware } from 'koa';
import { generateHmrProxy } from './generateHmrProxy';

interface TranspilerOptions {
    content: string;
    path: string;
}
export type Transpiler = (options: TranspilerOptions) => string | Promise<string>;

interface Options {
    rootPath: string;
    transpiler?: Transpiler;
    pathResolver?: (path: string) => string | Promise<string>;
}
export function generateProxyMiddleware(options: Options): Middleware {
    return async (context, next) => {
        const requestPath = context.request.path;

        const fullPath = path.join(options.rootPath, requestPath);
        const filePath = options.pathResolver ? await options.pathResolver(fullPath) : fullPath;

        let originalContent;
        try {
            originalContent = await fs.readFile(filePath, 'utf8');
        } catch (e) {
            if (e.code === 'ENOENT') {
                return next();
            }
            throw e;
        }

        const transpiledContent = options.transpiler
            ? await options.transpiler({ content: originalContent, path: filePath })
            : originalContent;

        context.response.set('Content-Type', 'application/javascript');
        if (!context.request.query.mtime) {
            context.response.body = generateHmrProxy(transpiledContent, context.request.URL);
        } else {
            context.response.body = transpiledContent;
        }
    };
}
