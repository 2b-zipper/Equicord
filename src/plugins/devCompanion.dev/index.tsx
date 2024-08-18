/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { canonicalizeMatch, canonicalizeReplace } from "@utils/patches";
import definePlugin, { OptionType, ReporterTestable } from "@utils/types";
import { CodeFilter, filters, findAll, search, stringMatches, wreq } from "@webpack";

const PORT = 8485;
const NAV_ID = "dev-companion-reconnect";

const logger = new Logger("DevCompanion");

let socket: WebSocket | undefined;

type Node = StringNode | RegexNode | FunctionNode;

interface StringNode {
    type: "string";
    value: string;
}

interface RegexNode {
    type: "regex";
    value: {
        pattern: string;
        flags: string;
    };
}

interface FunctionNode {
    type: "function";
    value: string;
}

interface PatchData {
    find: string;
    replacement: {
        match: StringNode | RegexNode;
        replace: StringNode | FunctionNode;
    }[];
}

interface FindData {
    type: string;
    args: Array<StringNode | FunctionNode>;
}

const settings = definePluginSettings({
    notifyOnAutoConnect: {
        description: "Whether to notify when Dev Companion has automatically connected.",
        type: OptionType.BOOLEAN,
        default: true
    }
});

function parseNode(node: Node) {
    switch (node.type) {
        case "string":
            return node.value;
        case "regex":
            return new RegExp(node.value.pattern, node.value.flags);
        case "function":
            // We LOVE remote code execution
            // Safety: This comes from localhost only, which actually means we have less permissions than the source,
            // since we're running in the browser sandbox, whereas the sender has host access
            return (0, eval)(node.value);
        default:
            throw new Error("Unknown Node Type " + (node as any).type);
    }
}
// we need to have our own because the one in webpack returns the first with no handling of more than one module
function findModuleId(find: CodeFilter) {
    const matches: string[] = [];
    for (const id in wreq.m) {
        if (stringMatches(wreq.m[id].toString(), find)) matches.push(id);
    }
    if (matches.length === 0) {
        throw new Error("No Matches Found");
    }
    if (matches.length !== 1) {
        throw new Error("More than one match");
    }
    return matches[0];
}
interface SendData {
    type: string,
    data: any,
    ok: boolean;
    nonce?: number;
}
function initWs(isManual = false) {
    let wasConnected = isManual;
    let hasErrored = false;
    const ws = socket = new WebSocket(`ws://localhost:${PORT}`);

    function replyData<T extends SendData>(data: T) {
        ws.send(JSON.stringify(data));
    }

    ws.addEventListener("open", () => {
        wasConnected = true;

        logger.info("Connected to WebSocket");

        // send module cache to vscode

        replyData({
            type: "moduleList",
            data: Object.keys(wreq.m),
            ok: true,
        });

        (settings.store.notifyOnAutoConnect || isManual) && showNotification({
            title: "Dev Companion Connected",
            body: "Connected to WebSocket",
            noPersist: true
        });
    });

    ws.addEventListener("error", e => {
        if (!wasConnected) return;

        hasErrored = true;

        logger.error("Dev Companion Error:", e);

        showNotification({
            title: "Dev Companion Error",
            body: (e as ErrorEvent).message || "No Error Message",
            color: "var(--status-danger, red)",
            noPersist: true
        });
    });

    ws.addEventListener("close", e => {
        if (!wasConnected || hasErrored) return;

        logger.info("Dev Companion Disconnected:", e.code, e.reason);

        showNotification({
            title: "Dev Companion Disconnected",
            body: e.reason || "No Reason provided",
            color: "var(--status-danger, red)",
            noPersist: true,
            onClick() {
                setTimeout(() => {
                    socket?.close(1000, "Reconnecting");
                    initWs(true);
                }, 2500);
            }
        });
    });

    ws.addEventListener("message", e => {
        try {
            var { nonce, type, data } = JSON.parse(e.data);
        } catch (err) {
            logger.error("Invalid JSON:", err, "\n" + e.data);
            return;
        }
        function reply(error?: string) {
            const data = { nonce, ok: !error } as Record<string, unknown>;
            if (error) data.error = error;

            ws.send(JSON.stringify(data));
        }
        function replyData<T extends SendData>(data: T) {
            data.nonce = nonce;
            ws.send(JSON.stringify(data));
        }

        logger.info("Received Message:", type, "\n", data);

        switch (type) {
            case "extract": {
                const { extractType, idOrSearch } = data;
                switch (extractType) {
                    case "id": {
                        console.log("ID!");
                        let data;
                        if (typeof idOrSearch === "number")
                            data = wreq.m[idOrSearch]?.toString() || null;
                        else {
                            return reply(`the provided moduleID is not a number. Got: ${typeof idOrSearch}`);
                        }
                        if (!data)
                            return reply(`Module(${idOrSearch}) not found`);
                        else
                            replyData({
                                type: "extract",
                                ok: true,
                                data,
                                moduleNumber: idOrSearch
                            });

                        break;
                    }
                    case "search": {
                        try {
                            const moduleId = findModuleId([idOrSearch.toString()]);
                            const data = wreq.m[moduleId].toString();
                            replyData({
                                type: "extract",
                                ok: true,
                                data,
                                moduleNumber: +moduleId
                            });
                        } catch (e) {
                            reply("Error: " + String(e));
                        }
                        break;
                    }
                    case "find": {
                        const { findType, findArgs } = data;
                        try {
                            var parsedArgs = findArgs.map(parseNode);
                        } catch (err) {
                            return reply("Failed to parse args: " + err);
                        }

                        try {
                            let results: any[];
                            switch (findType.replace("find", "").replace("Lazy", "")) {
                                case "":
                                    results = findAll(parsedArgs[0]);
                                    break;
                                case "ByProps":
                                    results = findAll(filters.byProps(...parsedArgs));
                                    break;
                                case "Store":
                                    results = findAll(filters.byStoreName(parsedArgs[0]));
                                    break;
                                case "ByCode":
                                    results = findAll(filters.byCode(...parsedArgs));
                                    break;
                                case "ModuleId":
                                    results = Object.keys(search(parsedArgs[0]));
                                    break;
                                case "ComponentByCode":
                                    results = findAll(filters.componentByCode(...parsedArgs));
                                    break;
                                default:
                                    return reply("Unknown Find Type " + findType);
                            }

                            const uniqueResultsCount = new Set(results).size;
                            if (uniqueResultsCount === 0) throw "No results";
                            if (uniqueResultsCount > 1) throw "Found more than one result! Make this filter more specific";
                            // best name ever
                            const foundFind: string = [...results][0].toString();
                            replyData({
                                type: "extract",
                                ok: true,
                                find: true,
                                data: foundFind,
                                moduleNumber: +findModuleId([foundFind])
                            });
                        } catch (err) {
                            return reply("Failed to find: " + err);
                        }
                        break;
                    }
                    default:
                        reply(`Unknown Extract type. Got: ${extractType}`);
                        break;
                }
                break;
            }
            case "testPatch": {
                const { find, replacement } = data as PatchData;

                const candidates = search(find);
                const keys = Object.keys(candidates);
                if (keys.length !== 1)
                    return reply("Expected exactly one 'find' matches, found " + keys.length);

                const mod = candidates[keys[0]];
                let src = String(mod.original ?? mod).replaceAll("\n", "");

                if (src.startsWith("function(")) {
                    src = "0," + src;
                }

                let i = 0;

                for (const { match, replace } of replacement) {
                    i++;

                    try {
                        const matcher = canonicalizeMatch(parseNode(match));
                        const replacement = canonicalizeReplace(parseNode(replace), "PlaceHolderPluginName");

                        const newSource = src.replace(matcher, replacement as string);

                        if (src === newSource) throw "Had no effect";
                        Function(newSource);

                        src = newSource;
                    } catch (err) {
                        return reply(`Replacement ${i} failed: ${err}`);
                    }
                }

                reply();
                break;
            }
            case "testFind": {
                const { type, args } = data as FindData;
                let parsedArgs;
                try {
                    parsedArgs = args.map(parseNode);
                } catch (err) {
                    return reply("Failed to parse args: " + err);
                }

                try {
                    let results: any[];
                    switch (type.replace("find", "").replace("Lazy", "")) {
                        case "":
                            results = findAll(parsedArgs[0]);
                            break;
                        case "ByProps":
                            results = findAll(filters.byProps(...parsedArgs));
                            break;
                        case "Store":
                            results = findAll(filters.byStoreName(parsedArgs[0]));
                            break;
                        case "ByCode":
                            results = findAll(filters.byCode(...parsedArgs));
                            break;
                        case "ModuleId":
                            results = Object.keys(search(parsedArgs[0]));
                            break;
                        case "ComponentByCode":
                            results = findAll(filters.componentByCode(...parsedArgs));
                            break;
                        default:
                            return reply("Unknown Find Type " + type);
                    }

                    const uniqueResultsCount = new Set(results).size;
                    if (uniqueResultsCount === 0) throw "No results";
                    if (uniqueResultsCount > 1) throw "Found more than one result! Make this filter more specific";
                } catch (err) {
                    return reply("Failed to find: " + err);
                }

                reply();
                break;
            }
            default:
                reply("Unknown Type " + type);
                break;
        }
    });
}

export default definePlugin({
    name: "DevCompanion",
    description: "Dev Companion Plugin",
    authors: [Devs.Ven, Devs.sadan],
    reporterTestable: ReporterTestable.None,
    settings,

    toolboxActions: {
        "Reconnect"() {
            socket?.close(1000, "Reconnecting");
            initWs(true);
        }
    },

    start() {
        initWs();
    },

    stop() {
        socket?.close(1000, "Plugin Stopped");
        socket = void 0;
    }
});
