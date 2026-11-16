import * as vscode from 'vscode';

const DEBOUNCE_MS = 300;       // longer on CPU: avoids piling up slow requests
const MAX_PREFIX_CHARS = 2000; // smaller context = faster on CPU
const MAX_SUFFIX_CHARS = 500;

const STOP_TOKENS = [
  '<|fim_prefix|>',
  '<|fim_suffix|>',
  '<|fim_middle|>',
  '<|file_sep|>',
  '<|endoftext|>',
  '\n\n', // crude stop at the first blank line (replace with tree-sitter later)
];

export function activate(context: vscode.ExtensionContext) {
  // ---- Status bar toggle (PRD US-005) ----
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'nextcode.toggle';

  const refreshStatus = () => {
    const enabled = vscode.workspace.getConfiguration('nextcode').get<boolean>('enabled', true);
    statusItem.text = enabled ? '$(sparkle) NextCode' : '$(circle-slash) NextCode off';
    statusItem.tooltip = enabled
      ? 'NextCode is on. Click to pause suggestions.'
      : 'NextCode is paused. Click to resume suggestions.';
  };
  refreshStatus();
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('nextcode.toggle', async () => {
      const cfg = vscode.workspace.getConfiguration('nextcode');
      const enabled = cfg.get<boolean>('enabled', true);
      await cfg.update('enabled', !enabled, vscode.ConfigurationTarget.Global);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('nextcode.enabled')) {
        refreshStatus();
      }
    })
  );

  // ---- Inline completion provider ----
  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, _ctx, token) {
      const cfg = vscode.workspace.getConfiguration('nextcode');
      if (!cfg.get<boolean>('enabled', true)) {
        return;
      }

      // Debounce: if the user keeps typing, VS Code cancels this call.
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS));
      if (token.isCancellationRequested) {
        return;
      }

      // Context: code before and after the cursor, trimmed to a budget.
      const text = document.getText();
      const offset = document.offsetAt(position);
      const prefix = text.slice(Math.max(0, offset - MAX_PREFIX_CHARS), offset);
      const suffix = text.slice(offset, offset + MAX_SUFFIX_CHARS);

      // Qwen-Coder FIM prompt. Change the tokens if you switch model families.
      const prompt = `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;

      // Cancel the in-flight HTTP request if the user types again.
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      try {
        const res = await fetch(
          cfg.get<string>('endpoint', 'http://localhost:11434/api/generate'),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: cfg.get<string>('model', 'qwen2.5-coder:1.5b'),
              prompt,
              raw: true,         // send the prompt as-is, no chat template
              stream: false,
              keep_alive: '30m', // keep the model loaded between requests
              options: {
                num_predict: 48,
                temperature: 0.2,
                stop: STOP_TOKENS,
              },
            }),
            signal: controller.signal,
          }
        );
        if (!res.ok) {
          return; // fail silently: never block typing (PRD US-007)
        }
        const data: any = await res.json();
        const completion: string | undefined = data?.response;
        if (!completion || token.isCancellationRequested) {
          return;
        }
        return [
          new vscode.InlineCompletionItem(completion, new vscode.Range(position, position)),
        ];
      } catch {
        return; // timeouts, network errors, aborted requests
      }
    },
  };

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider)
  );
}

export function deactivate() {}