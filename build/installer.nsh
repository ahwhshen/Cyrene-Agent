; Custom NSIS script for Cyrene Agent installer
; Adds a disclaimer page at the beginning of the installation
; Author: Playa-0v0
; Repository: https://github.com/Playa-0v0/Cyrene-Agent/tree/master

!include nsDialogs.nsh

; “是否创建桌面快捷方式”用户选项：勾选后快捷方式指向安装根目录的
; CyreneLauncher.vbs 启动脚本（静默启动无黑窗）；不勾则不建并清旧残留。
; electron-builder.yml 里 createDesktopShortcut 已改 false，模板自带的无条件创建被关掉，
; 快捷方式完全由下面的选项页接管。
; 注：Var/页面/customInstall 全部包在 !ifndef BUILD_UNINSTALLER 里，否则 makensis 生成
; 卸载器存根的编译遍会报 6001 “变量未引用”警告且 electron-builder 把警告当错误。
!ifndef BUILD_UNINSTALLER
  Var createDesktopShortcutChoice
  Var desktopShortcutCheckbox
!endif

!ifndef BUILD_UNINSTALLER
!macro customInit
  ; 默认勾选创建；静默安装（/S）跳过页面时也保持默认创建，行为与旧版一致
  StrCpy $createDesktopShortcutChoice "1"
!macroend

!macro customPageAfterChangeDir
  PageEx custom
    PageCallbacks DesktopShortcutPageCreate DesktopShortcutPageLeave
    Caption " "
  PageExEnd

  Function DesktopShortcutPageCreate
    !insertmacro MUI_HEADER_TEXT "附加选项" "选择是否创建桌面快捷方式"

    nsDialogs::Create 1018
    Pop $0

    ${NSD_CreateCheckbox} 10u 20u 280u 12u "创建桌面快捷方式（通过启动脚本静默启动，推荐）"
    Pop $desktopShortcutCheckbox
    ${NSD_Check} $desktopShortcutCheckbox

    ${NSD_CreateLabel} 10u 40u 280u 40u "快捷方式会指向安装目录里的 CyreneLauncher.vbs 启动脚本，双击即可后台启动，不弹终端窗口。"
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function DesktopShortcutPageLeave
    ${NSD_GetState} $desktopShortcutCheckbox $createDesktopShortcutChoice
  FunctionEnd
!macroend
!endif

; customInstall 只在安装器编译遍有效：BUILD_UNINSTALLER 遍里引用该 Var 会触发
; “未引用变量”警告被 electron-builder 当作错误，必须用 !ifndef 隔离
!macro customInstall
  !ifndef BUILD_UNINSTALLER
    ${if} $createDesktopShortcutChoice == "1"
      CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\CyreneLauncher.vbs" "" "$appExe" 0
      ClearErrors
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${else}
      # 用户选择不创建：清理旧版本自动生成的同名快捷方式残留
      Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${endIf}
  !endif
!macroend

!macro customUnInstall
  # createDesktopShortcut=false 后模板不再自动删桌面快捷方式，这里补删
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
!macroend

!macro customWelcomePage
  !insertmacro MUI_PAGE_INIT
  
  PageEx custom
    PageCallbacks DisclaimerPageCreate DisclaimerPageLeave
    Caption " "
  PageExEnd

  Function DisclaimerPageCreate
    !insertmacro MUI_HEADER_TEXT "声明 / Disclaimer" "请阅读以下重要信息"
    
    nsDialogs::Create 1018
    Pop $0

    ${NSD_CreateLabel} 10u 10u 280u 100u "本软件「昔涟 / Cyrene Agent」由 Playa-0v0 开发。$\r$\n$\r$\n原始仓库地址：$\r$\nhttps://github.com/Playa-0v0/Cyrene-Agent/tree/master$\r$\n$\r$\n本软件为开源项目，遵循项目许可证使用。$\r$\n$\r$\n点击「下一步 (Next)」继续安装。"
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function DisclaimerPageLeave
  FunctionEnd
!macroend
