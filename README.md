# 学习通工作控制台

学习通课程页的浮动控制台油猴脚本，提供视频任务控制、PPT 翻到末页、按需英语翻译和可调整的窗口布局。

## 功能

- 浮动窗口：标题栏任意方向拖动，四边和四角调整大小。
- `Alt + +` 放大、`Alt + -` 缩小；`Alt + Shift + C` 隐藏或恢复。
- 点击“开始”处理当前分段；PPT 课件会在开始前自动滚动到末页。
- 英语课程检测到英文正文后显示翻译页面。
- 默认使用 Edge 内置本地翻译；也保留 Google、MyMemory 和 OpenAI 兼容 API 备用。
- 支持 `studentstudy` 和 `mooc2-ans/mycourse/stu` 学习页面。

## 安装

1. 在 Edge 中安装 Tampermonkey。
2. 新建油猴脚本，将 `chaoxing-unified.user.js` 的完整内容粘贴进去并保存。
3. 打开学习通课程页面，控制台会自动出现。
4. 首次使用 Edge 本地翻译时，点击翻译按钮准备英中语言模型。模型安装完成后，翻译直接在当前面板内运行。

`mount-existing-edge.py` 是维护和调试用的 browser-harness 输入程序，不是油猴脚本。

## 测试

```powershell
& 'C:\Program Files\nodejs\node.exe' --test core.test.cjs window.test.cjs translation.test.cjs
```

测试只使用 Node 内置模块，不需要安装第三方依赖。

## 版本

当前版本：2.1.5
