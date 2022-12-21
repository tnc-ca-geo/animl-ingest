FROM alpine:3.17

RUN apk add nodejs npm

WORKDIR /usr/local/src/task
ADD . /usr/local/src/task

RUN npm install

CMD npm start
