FROM public.ecr.aws/sam/build-python3.7:latest

# Download exiftool and copy its executable and dependencies into
# /output/exiftool/

ENV EXIF_V=12.52

RUN mkdir /output && \
    cd /output && \
    curl -o Image-ExifTool-${EXIF_V}.tar.gz https://exiftool.org/Image-ExifTool-${EXIF_V}.tar.gz && \
    tar -zxf Image-ExifTool-${EXIF_V}.tar.gz && \
    mkdir exiftool && \
    cp Image-ExifTool-${EXIF_V}/exiftool exiftool/ && \
    cp -r Image-ExifTool-${EXIF_V}/lib exiftool/
