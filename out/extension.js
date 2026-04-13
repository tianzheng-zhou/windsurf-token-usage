"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const api_1 = require("./api");
const webview_1 = require("./webview");
let statusBarItem;
let lastData = null;
function fmtK(n) {
    if (n >= 1000000) {
        return (n / 1000000).toFixed(1) + "M";
    }
    if (n >= 1000) {
        return (n / 1000).toFixed(1) + "K";
    }
    return n.toString();
}
async function refreshData(showProgress = false) {
    const doRefresh = async () => {
        try {
            statusBarItem.text = "$(loading~spin) Fetching tokens...";
            lastData = await (0, api_1.fetchDashboardData)();
            const t = lastData.grandTotal;
            statusBarItem.text = `$(dashboard) ${fmtK(t.total)} tokens`;
            statusBarItem.tooltip = `Windsurf Token Usage\nInput: ${fmtK(t.inputTokens)} · Output: ${fmtK(t.outputTokens)} · Cached: ${fmtK(t.cachedTokens)}\n${lastData.conversations.length} conversations\nClick to open dashboard`;
            (0, webview_1.updateDashboard)(lastData);
        }
        catch (e) {
            statusBarItem.text = "$(warning) Tokens: N/A";
            statusBarItem.tooltip = `Windsurf Token Usage\nError: ${e.message}`;
            if (showProgress) {
                vscode.window.showErrorMessage(`Windsurf Token Usage: ${e.message}`);
            }
        }
    };
    if (showProgress) {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Fetching Windsurf token data...",
            cancellable: false,
        }, doRefresh);
    }
    else {
        await doRefresh();
    }
}
function activate(context) {
    // Only activate in Windsurf
    if (!vscode.env.appName?.toLowerCase().includes("windsurf")) {
        return;
    }
    // Status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    statusBarItem.command = "windsurf-token-usage.show";
    statusBarItem.text = "$(dashboard) Tokens: ...";
    statusBarItem.tooltip = "Windsurf Token Usage — Click to open dashboard";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    // Commands
    context.subscriptions.push(vscode.commands.registerCommand("windsurf-token-usage.show", async () => {
        if (!lastData) {
            await refreshData(true);
        }
        if (lastData) {
            (0, webview_1.showDashboard)(context, lastData);
        }
    }), vscode.commands.registerCommand("windsurf-token-usage.refresh", async () => {
        (0, api_1.clearCredentials)();
        await refreshData(true);
        if (lastData) {
            (0, webview_1.showDashboard)(context, lastData);
        }
    }));
    // Auto-fetch after a short delay
    setTimeout(() => refreshData(false), 8000);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map