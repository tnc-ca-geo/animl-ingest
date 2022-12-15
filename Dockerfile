FROM public.ecr.aws/sam/build-python3.7:latest

# Download exiftool and copy its executable and dependencies into 
# /output/exiftool/

RUN mkdir /output && \
    cd /output && \
    curl -o Image-ExifTool-12.52.tar.gz https://exiftool.org/Image-ExifTool-12.52.tar.gz && \
    tar -zxf Image-ExifTool-12.52.tar.gz && \
    mkdir exiftool && \
    cp Image-ExifTool-12.52/exiftool exiftool/ && \
    cp -r Image-ExifTool-12.52/lib exiftool/
