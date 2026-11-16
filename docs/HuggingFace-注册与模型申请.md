# Hugging Face 注册、模型访问申请与本机登录

本指南用于空间内容工场的真实图生 3D 依赖。平台的四种角色账号与 Hugging Face 账号是两套账号。

## 1. 注册并验证邮箱

打开 https://huggingface.co/join ，按页面填写邮箱、密码、用户名，完成注册。收到验证邮件后点击邮件中的验证链接。验证码、账号密码保留在你自己的浏览器或终端中。

## 2. 申请 DINOv3

打开 https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m ，确认已登录。阅读页面的访问条件，按实际情况填写姓名、单位、用途等必填信息，然后由账号本人确认许可并提交申请。

用途如果确实是内部评估，可填写：`Internal evaluation of a local image-to-3D content production pipeline.` 正式商用用途应如实填写。若页面显示申请待处理，等待提供方审核；不要将已提交申请当成已获准。

官方模型页说明访问需要同意共享 Hugging Face 账户信息及相应条款。

## 3. 申请 RMBG-2.0

打开 https://huggingface.co/briaai/RMBG-2.0 ，阅读条件、填写实际资料并提交页面表单。官方说明该表单提供非商业用途的模型访问，商业自托管需要另行签署商业协议。下载访问成功不等于获得商用授权。

## 4. 创建用于下载的 Token

在 https://huggingface.co/settings/tokens 选择 New token，名称可填 `scw-local-download`，选择 Read 权限。该 Token 用于下载你已经获准访问的模型，网页上的模型访问申请应先完成。

Token 只复制到本机终端，不发送到聊天，不放进源码或截图。

## 5. 在本机登录

在 Windows PowerShell 执行：

```powershell
wsl -d Ubuntu-22.04 -- env HF_HOME=/data/models/hf /opt/scw/miniforge3/envs/trellis2/bin/hf auth login
```

终端提示输入 Token 时粘贴；输入内容通常不会显示。若询问是否添加到 Git credential，选择 `n` 即可用于模型下载。也可运行项目的 `ops/production/login-hf.ps1`。

完成后告诉我“HF 已登录，两个模型已获准”，我会核验访问状态、继续下载并进行真实 GPU 推理验收。无需把 Token 发给我。

## 官方来源

- 注册：https://huggingface.co/join
- DINOv3：https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m
- RMBG-2.0：https://huggingface.co/briaai/RMBG-2.0
- Token 用途及权限：https://huggingface.co/docs/hub/security-tokens
