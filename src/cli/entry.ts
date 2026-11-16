#!/usr/bin/env node
/**
 * 可执行入口：package.json 的 bin.dsh 指向编译后的这个文件。
 * 只负责把进程参数交给 main，并保证异常不会变成一段裸栈。
 */
import { main } from "./index";
import { describeError } from "../types";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`dsh: 未捕获异常：${describeError(err)}\n`);
    process.exitCode = 1;
  });
