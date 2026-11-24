import { describe, expect, it } from "vitest"
import { describeJson, describeJsonText, peek } from "../../scripts/kb-peek.mjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kb-peek-test-"))

describe("describeJson 只描述结构", () => {
  it("标量只输出类型，不输出值", () => {
    expect(describeJson("客户真名")).toBe("string")
    expect(describeJson(42)).toBe("number")
    expect(describeJson(true)).toBe("boolean")
    expect(describeJson(null)).toBe("null")
  })

  it("数组输出长度和元素结构", () => {
    expect(describeJson([])).toBe("array(0)")
    expect(describeJson(["甲", "乙", "丙"])).toBe("array(3) of string")
    expect(describeJson([{ a: "x", b: 1 }])).toBe("array(1) of object{a:string,b:number}")
  })

  it("对象输出键名，不输出值", () => {
    const out = describeJson({ title: "某个客户的问题", shots: [{ hash: "abc" }], cost: 0.01 })
    expect(out).toBe("object{cost:number,shots:array(1) of object{hash},title:string}")
    expect(out).not.toContain("某个客户")
    expect(out).not.toContain("abc")
  })

  it("层级受限时只列键名", () => {
    const deep = { a: { b: { c: { d: "值" } } } }
    const out = describeJson(deep)
    expect(out).toContain("a:object{")
    expect(out).not.toContain("值")
  })

  it("坏 JSON 不抛错", () => {
    expect(describeJsonText("{ 坏")).toContain("不是合法 JSON")
  })
})

describe("peek", () => {
  it("目录：只给路径、字节数和 JSON 结构", () => {
    const dir = path.join(tmp, "data")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ name: "真名", list: [1, 2, 3] }))
    fs.writeFileSync(path.join(dir, "b.md"), "# 真名\n正文")
    const out = peek(dir, { baseDir: tmp })
    const text = out.lines.join("\n")
    expect(out.files).toBe(2)
    expect(text).toContain("a.json")
    expect(text).toContain("array(3)")
    expect(text).toContain("object{list:array(3) of number,name:string}")
    // 值绝不出现
    expect(text).not.toContain("真名")
    expect(text).not.toContain("正文")
  })

  it("单个文件也行", () => {
    const file = path.join(tmp, "one.json")
    fs.writeFileSync(file, JSON.stringify({ k: "v" }))
    const out = peek(file, { baseDir: tmp })
    expect(out.files).toBe(1)
    expect(out.lines.join("\n")).toContain("object{k:string}")
    expect(out.lines.join("\n")).not.toContain('"v"')
  })

  it("超过 maxDepth 的目录不展开", () => {
    const dir = path.join(tmp, "deep", "a", "b")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "x.json"), "{}")
    const out = peek(path.join(tmp, "deep"), { baseDir: tmp, maxDepth: 1 })
    expect(out.lines.join("\n")).toContain("未展开")
  })

  it("不存在的路径抛错", () => {
    expect(() => peek(path.join(tmp, "nope"))).toThrow()
  })
})
