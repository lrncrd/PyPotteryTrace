"""
Project Manager for PyPotteryTrace
Handles creation, loading, and management of project workspaces
"""

import json
import shutil
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional

class ProjectManager:
    """Manages project workspaces with hierarchical folder structure"""
    
    def __init__(self, projects_root: str = "projects"):
        self.projects_root = Path(projects_root)
        self.projects_root.mkdir(exist_ok=True)
    
    def create_project(self, project_name: str, description: str = "", icon: str = "🏺") -> Dict:
        """
        Create a new project with folder structure and metadata
        
        Args:
            project_name: Name of the project
            description: Optional project description
            icon: Project icon emoji
            
        Returns:
            Dict with project metadata
        """
        # Sanitize project name for filesystem
        safe_name = "".join(c for c in project_name if c.isalnum() or c in (' ', '-', '_')).strip()
        safe_name = safe_name.replace(' ', '_')
        
        # Create unique ID based on timestamp
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        project_id = f"{safe_name}_{timestamp}"
        
        project_path = self.projects_root / project_id
        
        # Check if project already exists
        if project_path.exists():
            raise ValueError(f"Project already exists: {project_id}")
        
        # Create folder structure specific to PyPotteryTrace
        folders = [
            'uploads',              # Original uploaded images
            'thumbnails',          # Cached thumbnails for performance
            'sessions',            # SAM2 segmentation sessions data
            'annotations',         # Annotation data (JSON files)
            'vectorized',          # Vectorized SVG outputs
            'exports',             # Final exports (SVG, PNG, JPG, ZIP)
            'ml_training',         # ML training data (COCO format) - always saved
        ]
        
        for folder in folders:
            (project_path / folder).mkdir(parents=True, exist_ok=True)
        
        # Create project metadata
        metadata = {
            'project_id': project_id,
            'project_name': project_name,
            'description': description,
            'icon': icon,
            'created_at': datetime.now().isoformat(),
            'last_modified': datetime.now().isoformat(),
            'workflow_status': {
                'images_uploaded': 0,
                'images_segmented': 0,
                'images_vectorized': 0,
                'images_exported': 0,
                'current_session': None,
                'current_image_index': 0,
                'processed_images': []  # List with status: {filename, segmented, vectorized}
            },
            'settings': {
                'sam2_model_size': 'small',
                'epsilon': 1.5,
                'smoothing_factor': 0.3,
                'include_background': False
            }
        }
        
        # Save metadata
        self._save_metadata(project_path, metadata)
        
        return metadata
    
    def list_projects(self) -> List[Dict]:
        """
        List all available projects
        
        Returns:
            List of project metadata dictionaries
        """
        projects = []
        
        if not self.projects_root.exists():
            return projects
        
        for project_dir in self.projects_root.iterdir():
            if project_dir.is_dir():
                metadata_file = project_dir / 'project.json'
                if metadata_file.exists():
                    try:
                        metadata = self._load_metadata(project_dir)
                        projects.append(metadata)
                    except Exception as e:
                        print(f"Error loading project {project_dir.name}: {e}")
        
        # Sort by last modified (most recent first)
        projects.sort(key=lambda x: x.get('last_modified', ''), reverse=True)
        
        return projects
    
    def get_project(self, project_id: str) -> Optional[Dict]:
        """
        Get metadata for a specific project
        
        Args:
            project_id: ID of the project
            
        Returns:
            Project metadata or None if not found
        """
        project_path = self.projects_root / project_id
        
        if not project_path.exists():
            return None
        
        try:
            return self._load_metadata(project_path)
        except Exception as e:
            print(f"Error loading project {project_id}: {e}")
            return None
    
    def delete_project(self, project_id: str) -> bool:
        """
        Delete a project and all its contents
        
        Args:
            project_id: ID of the project to delete
            
        Returns:
            True if successful, False otherwise
        """
        project_path = self.projects_root / project_id
        
        if not project_path.exists():
            return False
        
        try:
            shutil.rmtree(project_path)
            return True
        except Exception as e:
            print(f"Error deleting project {project_id}: {e}")
            return False
    
    def update_workflow_status(self, project_id: str, status_updates: Dict) -> bool:
        """
        Update workflow status for a project
        
        Args:
            project_id: ID of the project
            status_updates: Dictionary of status fields to update
            
        Returns:
            True if successful, False otherwise
        """
        project_path = self.projects_root / project_id
        
        if not project_path.exists():
            return False
        
        try:
            metadata = self._load_metadata(project_path)
            metadata['workflow_status'].update(status_updates)
            metadata['last_modified'] = datetime.now().isoformat()
            self._save_metadata(project_path, metadata)
            return True
        except Exception as e:
            print(f"Error updating workflow status for {project_id}: {e}")
            return False
    
    def update_settings(self, project_id: str, settings: Dict) -> bool:
        """
        Update project settings
        
        Args:
            project_id: ID of the project
            settings: Dictionary of settings to update
            
        Returns:
            True if successful, False otherwise
        """
        project_path = self.projects_root / project_id
        
        if not project_path.exists():
            return False
        
        try:
            metadata = self._load_metadata(project_path)
            metadata['settings'].update(settings)
            metadata['last_modified'] = datetime.now().isoformat()
            self._save_metadata(project_path, metadata)
            return True
        except Exception as e:
            print(f"Error updating settings for {project_id}: {e}")
            return False
    
    def get_project_path(self, project_id: str, subfolder: str = None) -> Optional[Path]:
        """
        Get the filesystem path for a project or its subfolder
        
        Args:
            project_id: ID of the project
            subfolder: Optional subfolder name (uploads, annotations, vectorized, etc.)
            
        Returns:
            Path object or None if project doesn't exist
        """
        project_path = self.projects_root / project_id
        
        if not project_path.exists():
            return None
        
        if subfolder:
            return project_path / subfolder
        
        return project_path
    
    def _load_metadata(self, project_path: Path) -> Dict:
        """Load project metadata from project.json"""
        metadata_file = project_path / 'project.json'
        with open(metadata_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    def _save_metadata(self, project_path: Path, metadata: Dict):
        """Save project metadata to project.json"""
        metadata_file = project_path / 'project.json'
        with open(metadata_file, 'w', encoding='utf-8') as f:
            json.dump(metadata, f, indent=2, ensure_ascii=False)
    
    def get_images_list(self, project_id: str, folder_type: str = 'uploads', include_status: bool = False) -> List:
        """
        Get list of images in a project folder
        
        Args:
            project_id: ID of the project
            folder_type: Type of folder (uploads, vectorized, etc.)
            include_status: If True, return dict with vectorization status
            
        Returns:
            List of image filenames or list of dicts with status info
        """
        folder_path = self.get_project_path(project_id, folder_type)
        
        if not folder_path or not folder_path.exists():
            return []
        
        # For vectorized folder, also include SVG files
        if folder_type == 'vectorized':
            valid_extensions = {'.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.svg'}
        else:
            valid_extensions = {'.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff'}
        
        images = []
        
        for file_path in folder_path.iterdir():
            if file_path.is_file() and file_path.suffix.lower() in valid_extensions:
                if include_status:
                    # Check if vectorized SVG exists
                    vectorized_path = self.get_project_path(project_id, 'vectorized')
                    svg_name = file_path.stem + '_vectorized.svg'
                    has_svg = vectorized_path and (vectorized_path / svg_name).exists()
                    
                    images.append({
                        'filename': file_path.name,
                        'vectorized': has_svg
                    })
                else:
                    images.append(file_path.name)
        
        return sorted(images, key=lambda x: x['filename'] if isinstance(x, dict) else x)
    
    def count_files(self, project_id: str, folder_type: str = 'uploads') -> int:
        """
        Count files in a project folder
        
        Args:
            project_id: ID of the project
            folder_type: Type of folder
            
        Returns:
            Number of files
        """
        return len(self.get_images_list(project_id, folder_type))
    
    def save_session_data(self, project_id: str, session_id: str, session_data: Dict) -> bool:
        """
        Save segmentation session data
        
        Args:
            project_id: ID of the project
            session_id: ID of the session
            session_data: Session data to save
            
        Returns:
            True if successful, False otherwise
        """
        sessions_path = self.get_project_path(project_id, 'sessions')
        
        if not sessions_path:
            return False
        
        try:
            session_file = sessions_path / f"{session_id}.json"
            
            with open(session_file, 'w', encoding='utf-8') as f:
                json.dump(session_data, f, indent=2, ensure_ascii=False)
            
            return True
        except Exception as e:
            print(f"Error saving session data: {e}")
            return False
    
    def load_session_data(self, project_id: str, session_id: str) -> Optional[Dict]:
        """
        Load segmentation session data
        
        Args:
            project_id: ID of the project
            session_id: ID of the session
            
        Returns:
            Session data or None if not found
        """
        sessions_path = self.get_project_path(project_id, 'sessions')
        
        if not sessions_path:
            return None
        
        try:
            session_file = sessions_path / f"{session_id}.json"
            
            if not session_file.exists():
                return None
            
            with open(session_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading session data: {e}")
            return None
    
    def list_sessions(self, project_id: str) -> List[Dict]:
        """
        List all sessions in a project
        
        Args:
            project_id: ID of the project
            
        Returns:
            List of session metadata
        """
        sessions_path = self.get_project_path(project_id, 'sessions')
        
        if not sessions_path or not sessions_path.exists():
            return []
        
        sessions = []
        
        for session_file in sessions_path.glob('*.json'):
            try:
                with open(session_file, 'r', encoding='utf-8') as f:
                    session_data = json.load(f)
                    sessions.append({
                        'session_id': session_file.stem,
                        'filename': session_data.get('filename'),
                        'created_at': session_data.get('created_at'),
                        'total_segments': len(session_data.get('segments', []))
                    })
            except Exception as e:
                print(f"Error loading session {session_file}: {e}")
        
        return sorted(sessions, key=lambda x: x.get('created_at', ''), reverse=True)
    
    def save_annotation_data(self, project_id: str, image_name: str, annotation_data: Dict) -> bool:
        """
        Save annotation data for an image
        
        Args:
            project_id: ID of the project
            image_name: Name of the image file
            annotation_data: Annotation data to save
            
        Returns:
            True if successful, False otherwise
        """
        annotations_path = self.get_project_path(project_id, 'annotations')
        
        if not annotations_path:
            return False
        
        try:
            # Create annotation filename (same as image but .json)
            base_name = Path(image_name).stem
            annotation_file = annotations_path / f"{base_name}_annotations.json"
            
            with open(annotation_file, 'w', encoding='utf-8') as f:
                json.dump(annotation_data, f, indent=2, ensure_ascii=False)
            
            return True
        except Exception as e:
            print(f"Error saving annotation data for {image_name}: {e}")
            return False
    
    def load_annotation_data(self, project_id: str, image_name: str) -> Optional[Dict]:
        """
        Load annotation data for an image
        
        Args:
            project_id: ID of the project
            image_name: Name of the image file
            
        Returns:
            Annotation data or None if not found
        """
        annotations_path = self.get_project_path(project_id, 'annotations')
        
        if not annotations_path:
            return None
        
        try:
            base_name = Path(image_name).stem
            annotation_file = annotations_path / f"{base_name}_annotations.json"
            
            if not annotation_file.exists():
                return None
            
            with open(annotation_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading annotation data for {image_name}: {e}")
            return None
    
    def get_project_stats(self, project_id: str) -> Optional[Dict]:
        """
        Get statistics for a project
        
        Args:
            project_id: ID of the project
            
        Returns:
            Dictionary with project statistics
        """
        project_path = self.get_project_path(project_id)
        
        if not project_path:
            return None
        
        try:
            metadata = self._load_metadata(project_path)
            
            stats = {
                'total_uploads': self.count_files(project_id, 'uploads'),
                'total_sessions': len(list((project_path / 'sessions').glob('*.json'))),
                'total_vectorized': self.count_files(project_id, 'vectorized'),
                'total_exports': len(list((project_path / 'exports').glob('*'))),
                'workflow_status': metadata.get('workflow_status', {}),
                'last_modified': metadata.get('last_modified')
            }
            
            return stats
        except Exception as e:
            print(f"Error getting project stats: {e}")
            return None
    
    def export_project_data(self, project_id: str, output_path: str) -> bool:
        """
        Export complete project data as ZIP archive
        
        Args:
            project_id: ID of the project
            output_path: Path where to save the ZIP file
            
        Returns:
            True if successful, False otherwise
        """
        project_path = self.get_project_path(project_id)
        
        if not project_path:
            return False
        
        try:
            import zipfile
            
            with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zip_file:
                for file_path in project_path.rglob('*'):
                    if file_path.is_file():
                        arcname = file_path.relative_to(project_path)
                        zip_file.write(file_path, arcname)
            
            return True
        except Exception as e:
            print(f"Error exporting project: {e}")
            return False
    
    def import_project_data(self, zip_path: str) -> Optional[str]:
        """
        Import project from ZIP archive
        
        Args:
            zip_path: Path to the ZIP file
            
        Returns:
            Project ID if successful, None otherwise
        """
        try:
            import zipfile
            import tempfile
            
            # Extract to temporary directory
            with tempfile.TemporaryDirectory() as temp_dir:
                with zipfile.ZipFile(zip_path, 'r') as zip_file:
                    zip_file.extractall(temp_dir)
                
                # Read metadata to get project info
                metadata_file = Path(temp_dir) / 'project.json'
                if not metadata_file.exists():
                    print("No project.json found in ZIP")
                    return None
                
                with open(metadata_file, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
                
                original_id = metadata.get('project_id')
                project_name = metadata.get('project_name')
                
                # Create new project ID with timestamp to avoid conflicts
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                safe_name = "".join(c for c in project_name if c.isalnum() or c in (' ', '-', '_')).strip()
                safe_name = safe_name.replace(' ', '_')
                new_project_id = f"{safe_name}_imported_{timestamp}"
                
                # Copy to projects directory
                new_project_path = self.projects_root / new_project_id
                shutil.copytree(temp_dir, new_project_path)
                
                # Update metadata with new ID
                metadata['project_id'] = new_project_id
                metadata['last_modified'] = datetime.now().isoformat()
                self._save_metadata(new_project_path, metadata)
                
                return new_project_id
        except Exception as e:
            print(f"Error importing project: {e}")
            return None
