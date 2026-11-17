import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { keywordCompletionSource, SQLDialect } from "@codemirror/lang-sql";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { EditorState, Prec } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";

import { KEYWORDS, TYPES } from "@/lib/query/clickhouse";
import { completionsFor } from "@/lib/query/completion";

const ClickHouse = SQLDialect.define({
  keywords: KEYWORDS,
  types: TYPES,
  backslashEscapes: true,
  doubleQuotedStrings: false,
  hashComments: true,
});

const SKIP = new Set(["String", "LineComment", "BlockComment", "QuotedIdentifier"]);

function querySource(context: CompletionContext) {
  const word = context.matchBefore(/\w*/);
  if (!word || (word.from === word.to && !context.explicit && context.state.sliceDoc(word.from - 1, word.from) !== ".")) return null;
  if (SKIP.has(syntaxTree(context.state).resolveInner(context.pos, -1).name)) return null;
  const qualifier = context.state.sliceDoc(0, word.from).match(/(\w+)\.$/)?.[1] ?? null;
  return { from: word.from, options: completionsFor(context.state.doc.toString(), qualifier), validFor: /^\w*$/ };
}

const keywords = keywordCompletionSource(ClickHouse, false, (label, type) => ({
  label: type === "keyword" ? label.toUpperCase() : label,
  type,
  boost: -1,
}));

const theme = EditorView.theme(
  {
    "&": { color: "hsl(var(--foreground))", backgroundColor: "transparent", fontSize: "13px" },
    ".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", caretColor: "hsl(var(--foreground))", padding: "10px 0" },
    ".cm-scroller": { lineHeight: "1.6" },
    "&.cm-focused": { outline: "none" },
    ".cm-gutters": { backgroundColor: "transparent", color: "hsl(var(--muted-foreground) / 0.6)", border: "none" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "hsl(var(--muted) / 0.35)" },
    ".cm-cursor": { borderLeftColor: "hsl(var(--foreground))" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "hsl(var(--muted)) !important",
    },
    ".cm-matchingBracket": { backgroundColor: "hsl(var(--muted))", outline: "none" },
    ".cm-placeholder": { color: "hsl(var(--muted-foreground))" },
    ".cm-tooltip": {
      backgroundColor: "hsl(var(--popover))",
      color: "hsl(var(--popover-foreground))",
      border: "1px solid hsl(var(--border))",
      borderRadius: "6px",
      overflow: "hidden",
    },
    ".cm-tooltip-autocomplete > ul": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", maxHeight: "16rem" },
    ".cm-tooltip-autocomplete > ul > li": { padding: "2px 8px" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "hsl(var(--accent))", color: "hsl(var(--accent-foreground))" },
    ".cm-completionDetail": { color: "hsl(var(--muted-foreground))", fontStyle: "normal", marginLeft: "0.75em" },
    ".cm-completionInfo": { padding: "6px 8px", maxWidth: "22rem", fontFamily: "inherit" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#7dd3fc" },
  { tag: [tags.typeName, tags.standard(tags.name)], color: "#c4b5fd" },
  { tag: tags.string, color: "#fcd34d" },
  { tag: [tags.number, tags.bool, tags.null], color: "#fdba74" },
  { tag: [tags.lineComment, tags.blockComment], color: "#71717a" },
  { tag: tags.operator, color: "#d4d4d8" },
]);

export interface SqlEditorHandle {
  /** Inserts text at the cursor (the schema panel's tables and columns). */
  insert(text: string): void;
  focus(): void;
}

/**
 * The Query page's SQL editor (CodeMirror): ClickHouse keywords, completion of the Query views' tables and
 * columns (with their types and descriptions) and of common functions. ⌘/Ctrl+Enter runs, ⌘/Ctrl+S saves.
 */
export const SqlEditor = forwardRef<SqlEditorHandle, { value: string; onChange: (value: string) => void; onRun: () => void; onSave: () => void }>(
  function SqlEditor({ value, onChange, onRun, onSave }, ref) {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const callbacks = useRef({ onChange, onRun, onSave });
    callbacks.current = { onChange, onRun, onSave };

    useEffect(() => {
      const editor = new EditorView({
        parent: host.current!,
        state: EditorState.create({
          doc: value,
          extensions: [
            lineNumbers(),
            history(),
            drawSelection(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            highlightActiveLine(),
            ClickHouse,
            ClickHouse.language.data.of({ autocomplete: querySource }),
            ClickHouse.language.data.of({ autocomplete: keywords }),
            autocompletion({ icons: false }),
            syntaxHighlighting(highlight),
            theme,
            placeholder("SELECT … FROM invocations"),
            EditorView.lineWrapping,
            Prec.highest(
              keymap.of([
                { key: "Mod-Enter", run: () => (callbacks.current.onRun(), true) },
                { key: "Mod-s", run: () => (callbacks.current.onSave(), true), preventDefault: true },
              ]),
            ),
            keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
            }),
          ],
        }),
      });
      view.current = editor;
      return () => editor.destroy();
      // Created once; `value` changes from outside are applied below.
    }, []);

    useEffect(() => {
      const editor = view.current;
      if (!editor || editor.state.doc.toString() === value) return;
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }, [value]);

    useImperativeHandle(ref, () => ({
      insert(text: string) {
        const editor = view.current;
        if (!editor) return;
        editor.dispatch(editor.state.replaceSelection(text));
        editor.focus();
      },
      focus: () => view.current?.focus(),
    }));

    return <div ref={host} className="min-h-40 [&_.cm-editor]:min-h-40 [&_.cm-scroller]:max-h-[50vh]" />;
  },
);
