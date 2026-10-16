# scripts/pick-folder.ps1
# Modern Windows IFileOpenDialog with FOS_PICKFOLDERS (native Windows File Explorer "Selecionar Pasta")
param(
    [string]$Title = "Selecionar Pasta do Projeto - MomAI Code"
)

$code = @'
using System;
using System.Runtime.InteropServices;

public class NativeFolderPicker {
    [ComImport]
    [Guid("D57C52D1-A429-4A40-9771-345E28FF50A3")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes();
        void SetFileTypeIndex();
        void GetFileTypeIndex();
        void Advise();
        void Unadvise();
        void SetOptions(uint fos);
        void GetOptions(out uint fos);
        void SetDefaultFolder(IntPtr psi);
        void SetFolder(IntPtr psi);
        void GetFolder(out IntPtr ppsi);
        void GetCurrentSelection(out IntPtr ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName(out IntPtr pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
        void BindToHandler();
        void GetParent();
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes();
        void Compare();
    }

    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    [ClassInterface(ClassInterfaceType.None)]
    private class FileOpenDialogRCW {}

    public static string SelectFolder(string title) {
        var dialog = (IFileOpenDialog)new FileOpenDialogRCW();
        if (!string.IsNullOrEmpty(title)) {
            dialog.SetTitle(title);
        }
        // FOS_PICKFOLDERS (0x20) | FOS_FORCEFILESYSTEM (0x40)
        dialog.SetOptions(0x20 | 0x40);
        int hr = dialog.Show(IntPtr.Zero);
        if (hr == 0) {
            IShellItem item;
            dialog.GetResult(out item);
            string path;
            item.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
            return path;
        }
        return null;
    }
}
'@

try {
    Add-Type -TypeDefinition $code -ErrorAction Stop
    $result = [NativeFolderPicker]::SelectFolder($Title)
    if ($result) {
        Write-Output $result
    }
} catch {
    # Fallback to standard OpenFileDialog if COM compilation is blocked
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.ValidateNames = $false
    $dialog.CheckFileExists = $false
    $dialog.CheckPathExists = $true
    $dialog.FileName = "Selecionar Pasta"
    $dialog.Title = $Title
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        [System.IO.Path]::GetDirectoryName($dialog.FileName)
    }
}
