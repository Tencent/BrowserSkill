import { page } from "../../../lib/fixtures.mjs";

// The browser regression and the CLI corpus use the same editor structure.
export const editorMarkup = `<input id="guard" aria-label="Unrelated field" value="untouched">
<textarea id="notes" aria-label="Notes">old notes</textarea>
<div id="editor" contenteditable aria-label="Message editor" style="white-space: pre-wrap"><p id="paragraph">old paragraph</p><p>second paragraph</p></div>
<div id="outside">outside text</div>`;

export const acceptedTargets = [
  {
    name: "line breaks and whitespace",
    markup: '<div id="target" contenteditable="true" style="white-space: pre-wrap"></div>',
    steps: [
      ["\n", true, "\n"],
      ["\n\n", true, "\n\n"],
      ["a\r\nb", true, "a\nb"],
      [" ", true, " "],
    ],
  },
  {
    name: "normal whitespace style",
    markup: '<div id="target" contenteditable="true"></div>',
    steps: [
      [" a  b ", true, " a  b ", "\u00a0a  b\u00a0"],
      ["!", false, " a  b !", "\u00a0a  b !"],
    ],
  },
  {
    name: "append to existing paragraphs",
    markup: '<div id="target" contenteditable="true"><p>first</p><p>second</p></div>',
    steps: [["!", false, "first\n\nsecond!"]],
  },
  ...["text", "search", "tel", "url", "password"].map((type) => ({
    name: `${type} input`,
    markup: `<input id="target" type="${type}" value="old">`,
    steps: [
      ["你好🙂", true, "你好🙂"],
      ["!", false, "你好🙂!"],
      ["", false, "你好🙂!"],
      ["", true, ""],
    ],
  })),
  {
    name: "email input",
    markup: '<input id="target" type="email" value="a@b.com">',
    steps: [
      ["x@y.com", true, "x@y.com"],
      [".cn", false, "x@y.com.cn"],
    ],
  },
  {
    name: "number input",
    markup: '<input id="target" type="number" value="12">',
    steps: [
      ["34", true, "34"],
      ["5", false, "345"],
      ["", true, ""],
    ],
  },
  {
    name: "textarea",
    markup: '<textarea id="target">old</textarea>',
    steps: [
      ["a\r\nb", true, "a\nb"],
      ["\n你好🙂", false, "a\nb\n你好🙂"],
      ["", true, ""],
    ],
  },
  ...["", "true", "plaintext-only"].map((attribute) => ({
    name: `editable=${JSON.stringify(attribute)}`,
    markup: `<div id="target" contenteditable="${attribute}" style="white-space: pre-wrap"><p>old</p><p>second</p></div>`,
    steps: [
      ["你好🙂", true, "你好🙂"],
      ["\nnext\n", false, "你好🙂\nnext\n"],
      ["", false, "你好🙂\nnext\n"],
      ["", true, ""],
      ["again", false, "again"],
    ],
  })),
  ...["", "<br>", " ", "\n", "<p><br></p>"].map((initial) => ({
    name: `empty root ${JSON.stringify(initial)}`,
    markup: `<div id="target" contenteditable="true">${initial}</div>`,
    steps: [
      ["hello", false, "hello"],
      ["", true, ""],
      ["\u200b", false, "\u200b"],
    ],
  })),
  {
    name: "preserved whitespace",
    markup: '<div id="target" contenteditable="true" style="white-space: pre-wrap"> </div>',
    steps: [
      ["hello", false, " hello"],
      [" \n ", true, " \n "],
    ],
  },
  {
    name: "native input inside editor",
    markup: '<div contenteditable="true"><input id="target" value="old"></div>',
    steps: [
      ["hello", true, "hello"],
      ["!", false, "hello!"],
    ],
  },
  {
    name: "independent root inside noneditable island",
    markup:
      '<div contenteditable="true">before<div contenteditable="false"><div id="target" contenteditable="true">old</div></div>after</div>',
    steps: [
      ["hello", true, "hello"],
      ["!", false, "hello!"],
    ],
  },
];

export const rejectedTargets = [
  ...[
    '<p id="target">old</p>',
    '<p id="target"></p>',
    '<p id="target"> </p>',
    '<p id="target"><br></p>',
    '<p id="target" tabindex="0">old</p>',
    '<p>a <span id="target">old</span> b</p>',
    '<p id="target" contenteditable="true" tabindex="0">old</p>',
    '<p id="target" contenteditable="plaintext-only" tabindex="0">old</p>',
    '<p id="target" contenteditable="false" tabindex="0">old</p>',
  ].map((target) => ({
    name: target,
    markup: `<div contenteditable="true"><p>before</p>${target}<p>keep</p></div>`,
  })),
  { name: "noneditable textbox", markup: '<div id="target" role="textbox" tabindex="0">old</div>' },
  { name: "readonly input", markup: '<input id="target" readonly value="old">' },
  {
    name: "disabled fieldset",
    markup: '<fieldset disabled><input id="target" value="old"></fieldset>',
  },
  ...["checkbox", "radio", "range", "date", "file"].map((type) => ({
    name: `${type} input`,
    markup: `<input id="target" type="${type}">`,
  })),
];

export default {
  id: "fill-editor-roots",
  routes: ["/fill-editor-roots"],
  render() {
    return page({
      title: "Fill editor roots",
      body: `<section class="card"><h1>Fill editor roots</h1>${editorMarkup}<button id="check">Check values</button><p id="result"></p></section>`,
      script: `document.querySelector('#check').addEventListener('click', () => {
        const data = {
          notes: document.querySelector('#notes').value,
          editor: document.querySelector('#editor').innerText,
          guard: document.querySelector('#guard').value,
          outside: document.querySelector('#outside').textContent,
        };
        browserEval.send('fill.checked', data);
        document.querySelector('#result').textContent = 'FILL-ROOTS-OK';
      });`,
    });
  },
};
