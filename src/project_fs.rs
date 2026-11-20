//! 프로젝트 경계의 실제 I/O는 열린 디렉터리 capability를 기준으로 수행한다.
//! 경로를 검사한 뒤 ambient 경로로 다시 여는 fallback을 두지 않는다.

use cap_std::fs::{Dir, OpenOptions};
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

#[cfg(test)]
mod tests;

#[derive(Debug)]
pub(crate) struct ProjectFs {
    root: PathBuf,
    pub dir: Dir,
}

impl ProjectFs {
    pub fn open(root: &Path) -> io::Result<Self> {
        let root = crate::util::canonical(root)?;
        let dir = Dir::open_ambient_dir(&root, cap_std::ambient_authority())?;
        Ok(Self { root, dir })
    }

    pub fn root(&self) -> &Path { &self.root }

    pub fn relative(&self, path: &Path) -> io::Result<PathBuf> {
        let relative = path.strip_prefix(&self.root).map_err(|_| io::Error::new(io::ErrorKind::PermissionDenied, "프로젝트 밖 경로입니다"))?;
        if relative.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "프로젝트 밖 경로입니다"));
        }
        Ok(if relative.as_os_str().is_empty() { ".".into() } else { relative.to_path_buf() })
    }

    fn parent(&self, path: &Path) -> io::Result<(Dir, OsString)> {
        let rel = self.relative(path)?;
        let name = rel.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "파일 이름이 없습니다"))?.to_os_string();
        let parent = rel.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        Ok((self.dir.open_dir(parent)?, name))
    }

    pub fn open_file(&self, path: &Path) -> io::Result<File> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            // FIFO·장치로 교체돼도 open에서 멈추지 않고 열린 객체의 종류로 거절한다.
            options.custom_flags(libc::O_NONBLOCK);
        }
        let file = self.dir.open_with(self.relative(path)?, &options)?.into_std();
        let meta = file.metadata()?;
        if meta.is_dir() {
            return Err(io::Error::new(io::ErrorKind::IsADirectory, "디렉터리입니다"));
        }
        if !meta.is_file() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "일반 파일이 아닙니다"));
        }
        Ok(file)
    }

    pub fn read(&self, path: &Path, max: u64) -> io::Result<Vec<u8>> {
        let file = self.open_file(path)?;
        let mut bytes = Vec::new();
        file.take(max.saturating_add(1)).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > max {
            return Err(io::Error::new(io::ErrorKind::FileTooLarge, "파일 크기 제한을 넘었습니다"));
        }
        Ok(bytes)
    }

    pub fn metadata(&self, path: &Path) -> io::Result<cap_std::fs::Metadata> {
        self.dir.metadata(self.relative(path)?)
    }

    pub fn symlink_metadata(&self, path: &Path) -> io::Result<cap_std::fs::Metadata> {
        self.dir.symlink_metadata(self.relative(path)?)
    }

    pub fn create_dir(&self, path: &Path, private: bool) -> io::Result<()> {
        let mut builder = cap_std::fs::DirBuilder::new();
        #[cfg(unix)]
        if private {
            use cap_std::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        #[cfg(not(unix))]
        let _ = private;
        self.dir.create_dir_with(self.relative(path)?, &builder)
    }

    pub fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        self.dir.create_dir_all(self.relative(path)?)
    }

    pub fn write_new(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        self.publish(path, bytes, false)
    }

    pub fn atomic_write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        self.publish(path, bytes, true)
    }

    fn publish(&self, path: &Path, bytes: &[u8], replace: bool) -> io::Result<()> {
        let (parent, name) = self.parent(path)?;
        let permissions = match parent.metadata(&name) {
            Ok(meta) => Some(meta.permissions()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        let temp = OsString::from(format!(".{}.grove-{}.tmp", name.to_string_lossy(), crate::util::new_id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        let mut file = parent.open_with(&temp, &options)?;
        let result = (|| {
            file.write_all(bytes)?;
            if let Some(permissions) = permissions { file.set_permissions(permissions)?; }
            file.sync_all()?;
            drop(file);
            if replace { return parent.rename(&temp, &parent, &name); }
            #[cfg(any(target_os = "linux", windows))]
            { rename_noreplace(&parent, &temp, &parent, &name) }
            #[cfg(not(any(target_os = "linux", windows)))]
            {
                // 일반 파일의 완성본 게시: link는 기존 이름을 덮어쓰지 않는다.
                parent.hard_link(&temp, &parent, &name)?;
                parent.remove_file(&temp)
            }
        })();
        if result.is_err() { let _ = parent.remove_file(&temp); }
        result
    }

    pub fn rename_noreplace(&self, from: &Path, target: &Self, to: &Path) -> io::Result<()> {
        let (source, name) = self.parent(from)?;
        let (destination, new_name) = target.parent(to)?;
        rename_noreplace(&source, &name, &destination, &new_name)
    }

    pub fn remove_dir_all(&self, path: &Path) -> io::Result<()> {
        self.dir.remove_dir_all(self.relative(path)?)
    }

    pub fn remove_file(&self, path: &Path) -> io::Result<()> {
        self.dir.remove_file(self.relative(path)?)
    }

    pub fn copy_recursive(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.copy_to(from, self, to)
    }

    pub fn copy_to(&self, from: &Path, destination: &Self, to: &Path) -> io::Result<()> {
        let meta = self.symlink_metadata(from)?;
        if meta.file_type().is_symlink() {
            #[cfg(unix)]
            return destination.dir.symlink_contents(self.dir.read_link_contents(self.relative(from)?)?, destination.relative(to)?);
            #[cfg(not(unix))]
            return Err(io::Error::new(io::ErrorKind::Unsupported, "이 플랫폼에서는 symlink를 따라 복제하지 않습니다"));
        }
        if meta.is_dir() {
            destination.create_dir(to, true)?;
            for entry in self.dir.read_dir(self.relative(from)?)? {
                let name = entry?.file_name();
                self.copy_to(&from.join(&name), destination, &to.join(&name))?;
            }
            destination.dir.set_permissions(destination.relative(to)?, meta.permissions())?;
        } else {
            let mut input = self.open_file(from)?;
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            let mut output = destination.dir.open_with(destination.relative(to)?, &options)?;
            io::copy(&mut input, &mut output)?;
            output.set_permissions(meta.permissions())?;
            output.sync_all()?;
        }
        Ok(())
    }
}

fn rename_noreplace(from: &Dir, name: &std::ffi::OsStr, to: &Dir, new_name: &std::ffi::OsStr) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;
        let name = std::ffi::CString::new(name.as_bytes())?;
        let new_name = std::ffi::CString::new(new_name.as_bytes())?;
        // 양쪽 부모는 열린 directory handle이며 이름에는 separator가 없다.
        let result = unsafe { libc::renameat2(from.as_raw_fd(), name.as_ptr(), to.as_raw_fd(), new_name.as_ptr(), libc::RENAME_NOREPLACE) };
        if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
    }
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        use std::os::windows::{ffi::OsStrExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            DELETE, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
            FILE_RENAME_INFO, FileRenameInfo, SYNCHRONIZE, SetFileInformationByHandle,
        };
        let mut options = OpenOptions::new();
        options.read(true).access_mode(DELETE | SYNCHRONIZE | FILE_READ_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
        let source = from.open_with(name, &options)?;
        let name: Vec<u16> = new_name.encode_wide().collect();
        let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
        let bytes = offset + (name.len() + 1) * 2;
        let mut aligned = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
        let info = aligned.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        // 0으로 채운 buffer는 ReplaceIfExists=false다. RootDirectory 기준 최종 이름만 넘긴다.
        unsafe {
            (*info).RootDirectory = to.as_raw_handle();
            (*info).FileNameLength = u32::try_from(name.len() * 2).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "파일 이름이 너무 깁니다"))?;
            std::ptr::copy_nonoverlapping(name.as_ptr(), std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(), name.len());
            if SetFileInformationByHandle(source.as_raw_handle(), FileRenameInfo, info.cast(), bytes as u32) != 0 {
                Ok(())
            } else { Err(io::Error::last_os_error()) }
        }
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = (from, name, to, new_name);
        Err(io::Error::new(io::ErrorKind::Unsupported, "안전한 이동을 지원하지 않는 OS입니다"))
    }
}
