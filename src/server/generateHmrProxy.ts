import { URL } from 'url';
import { parseModule } from './parseModule';
import { ExportNamedDeclaration, FunctionDeclaration, VariableDeclaration, ClassDeclaration, Pattern } from 'estree';

class HMRProxyGenerator {
    private source: string;
    private originalUrl: URL;

    // map from export name to alias
    private proxiedExports: Map<string, string> = new Map();
    private usedNames: Set<string> = new Set();
    private imports: Set<string> = new Set();
    private isReloadable = true;

    constructor(source: string, originalUrl: URL) {
        this.source = source;
        this.originalUrl = originalUrl;
    }

    generate(): string {
        const program = parseModule(this.source);
        for (const statement of program.body) {
            switch (statement.type) {
                case 'ExportNamedDeclaration':
                    this.proxyNamedDeclaration(statement);
                    break;
                case 'ExportDefaultDeclaration':
                    this.proxyName('default', '_default');
                    break;
                case 'ImportDeclaration':
                    this.imports.add(this.resolveImport(statement.source.value as string));
                    break;
            }
        }

        if (!this.isReloadable) {
            return this.generateNonReloadableProxy();
        }

        if (this.proxiedExports.size === 0) {
            return this.generateNoExportsProxy();
        }
        return this.generateExportsProxy();
    }

    private resolveImport(relativeImport: string): string {
        return new URL(relativeImport, this.originalUrl).href;
    }

    private proxyNamedDeclaration(exportDeclaration: ExportNamedDeclaration) {
        if (exportDeclaration.declaration) {
            this.proxyDeclaration(exportDeclaration.declaration);
        }
        for (const specifier of exportDeclaration.specifiers) {
            this.proxyName(specifier.exported.name);
        }
    }

    private proxyDeclaration(declaration: VariableDeclaration | FunctionDeclaration | ClassDeclaration) {
        if (declaration.type === 'VariableDeclaration') {
            if (declaration.kind !== 'const') {
                this.isReloadable = false;
                return;
            }
            for (const variableDeclaration of declaration.declarations) {
                this.proxyPattern(variableDeclaration.id);
            }
        } else {
            // class or function
            this.proxyName(declaration.id!.name);
        }
    }

    private proxyPattern(pattern: Pattern) {
        switch (pattern.type) {
            case 'Identifier':
                this.proxyName(pattern.name);
                break;
            case 'ObjectPattern':
                pattern.properties.forEach(property => this.proxyPattern(property.value));
                break;
            case 'ArrayPattern':
                pattern.elements.forEach(element => this.proxyPattern(element));
                break;
            case 'RestElement':
                this.proxyPattern(pattern.argument);
                break;
            case 'AssignmentPattern':
                this.proxyPattern(pattern.left);
                break;
            default:
                throw new TypeError(`Unknown pattern type ${pattern.type}`);
        }
    }

    private proxyName(name: string, alias: string = name) {
        if (this.usedNames.has(alias)) {
            alias = this.getUniqueName(alias);
        }
        this.usedNames.add(alias);
        this.proxiedExports.set(name, alias);
    }

    private generateNonReloadableProxy(): string {
        return [
            `export * from "${this.originalUrl}?mtime=0";`,
            `import { client } from "/@hmr";`,
            '',
            'client.registerNonReloadableModule(',
            `    "${this.originalUrl}"`,
            ');'
        ].join('\n');
    }

    private generateNoExportsProxy(): string {
        return [
            `import "${this.originalUrl}?mtime=0";`,
            `import { client } from "/@hmr";`,
            '',
            'client.registerModule(',
            `    "${this.originalUrl}",`,
            '    [],',
            `    ${JSON.stringify(Array.from(this.imports))}`,
            ');'
        ].join('\n');
    }

    private generateExportsProxy(): string {
        const exportNames = [];
        const imports = [];
        const assignments = [];
        const reexports = [];
        const reassignments = [];
        let clientVarName = this.getUniqueName('client');

        for (const [proxiedName, importAlias] of this.proxiedExports) {
            exportNames.push(proxiedName);
            if (proxiedName === importAlias) {
                imports.push(`    ${proxiedName}`);
            } else {
                imports.push(`    ${proxiedName} as ${importAlias}`);
            }

            const localVariableName = this.getUniqueName(importAlias);
            assignments.push(`let ${localVariableName} = ${importAlias};`);
            reexports.push(`    ${localVariableName} as ${proxiedName}`);
            reassignments.push(`        ${localVariableName} = updated.${proxiedName};`);
        }

        return [
            'import {',
            imports.join(',\n'),
            `} from '${this.originalUrl}?mtime=0';`,
            `import { ${clientVarName} } from "/@hmr";`,
            assignments.join('\n'),
            '',
            'export {',
            reexports.join(',\n'),
            '};',
            '',
            `${clientVarName}.registerModule(`,
            `    ${JSON.stringify(this.originalUrl)},`,
            `    ${JSON.stringify(exportNames)},`,
            `    ${JSON.stringify(Array.from(this.imports))},`,
            `    (updated) => {`,
            reassignments.join('\n'),
            '    }',
            ');'
        ].join('\n');
    }

    private getUniqueName(desiredName: string): string {
        if (!this.usedNames.has(desiredName)) {
            this.usedNames.add(desiredName);
            return desiredName;
        }

        let idx = 0;
        let name;
        do {
            name = `${desiredName}${idx++}`;
        } while (this.usedNames.has(name));

        this.usedNames.add(name);
        return name;
    }
}

export function generateHmrProxy(source: string, originalUrl: URL): string {
    const generator = new HMRProxyGenerator(source, originalUrl);
    return generator.generate();
}
