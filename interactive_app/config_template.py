# PyPotteryTrace Interactive - Configuration Template
# Copy this file to config.py and customize as needed

# Flask Configuration
FLASK_SECRET_KEY = 'change-this-to-a-random-secret-key'
FLASK_DEBUG = False  # Set to True for development
FLASK_HOST = '0.0.0.0'
FLASK_PORT = 5000

# Upload Configuration
UPLOAD_FOLDER = 'uploads'
MAX_CONTENT_LENGTH = 50 * 1024 * 1024  # 50MB max file size
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'tiff', 'bmp'}

# SAM2 Configuration
SAM2_MODEL_SIZE = 'small'  # Options: 'tiny', 'small', 'base', 'large'
SAM2_DEVICE = 'auto'  # Options: 'auto', 'cuda', 'cpu'

# Vectorization Default Parameters
DEFAULT_EPSILON = 1.5
DEFAULT_SMOOTHING_FACTOR = 0.3
DEFAULT_MIN_DOTTED_AREA = 5
DEFAULT_MAX_DOTTED_AREA = 200
DEFAULT_DOTTED_CIRCULARITY = 0.6
DEFAULT_DARK_THRESHOLD = 100
DEFAULT_MIN_DECORATION_AREA = 1000

# Session Configuration (for production)
# SESSION_TYPE = 'redis'  # Use Redis for production
# SESSION_REDIS = redis.from_url('redis://localhost:6379')
# PERMANENT_SESSION_LIFETIME = timedelta(hours=24)

# Logging
LOG_LEVEL = 'INFO'  # Options: 'DEBUG', 'INFO', 'WARNING', 'ERROR'
LOG_FILE = 'pypotterytrace.log'

# Feature Flags
ENABLE_BACKGROUND_EXPORT = True
ENABLE_DEBUG_IMAGES = True
ENABLE_BATCH_PROCESSING = False  # Future feature

# Performance
MAX_IMAGE_DIMENSION = 4096  # Max width/height for uploaded images
RESIZE_LARGE_IMAGES = True  # Auto-resize images larger than MAX_IMAGE_DIMENSION

# Security (for production)
ENABLE_CSRF_PROTECTION = True
CORS_ORIGINS = ['http://localhost:3000']  # Adjust for your frontend
