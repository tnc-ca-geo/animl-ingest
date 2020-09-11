FROM lambci/lambda:build-python3.6

# Download exiftool and copy its executable and dependencies into 
# /output/exiftool/

RUN mkdir /output && \
    cd /output && \
    curl -o Image-ExifTool-12.01.tar.gz https://exiftool.org/Image-ExifTool-12.01.tar.gz && \
    tar -zxf Image-ExifTool-12.01.tar.gz && \
    mkdir exiftool && \
    cp Image-ExifTool-12.01/exiftool exiftool/ && \
    cp -r Image-ExifTool-12.01/lib exiftool/