import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LegalDialogFooter } from "./legal-dialog-footer";

test("保存失败在固定底栏的按钮旁显示错误，不随表单滚动隐藏", () => {
  const error = "保存失败：民法典施行日期应为2021-01-01。当前修改尚未保存。";
  const html = renderToStaticMarkup(<LegalDialogFooter error={error}><button>保存并返回命题</button></LegalDialogFooter>);
  assert.ok(html.startsWith('<footer class="shrink-0'));
  assert.ok(html.includes('role="alert"'));
  assert.ok(html.includes(error));
  assert.ok(html.indexOf(error) < html.indexOf("<button>"));
});

test("没有错误时底栏不显示警告", () => {
  const html = renderToStaticMarkup(<LegalDialogFooter error=""><button>保存</button></LegalDialogFooter>);
  assert.ok(!html.includes('role="alert"'));
  assert.ok(html.includes("<button>保存</button>"));
});
